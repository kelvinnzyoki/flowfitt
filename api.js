/**
 * FlowFit API Client
 * Auth strategy: HTTP-only cookies (ff_access + ff_refresh)
 * - Tokens are NEVER stored in localStorage or readable by JS
 * - Every fetch uses credentials:'include' so cookies are sent automatically
 * - Only user profile data is kept in localStorage for UI display purposes
 */

const API_CONFIG = {
    baseURL: 'https://fit.cctamcc.site/api/v1',
    timeout: 15000,
};

// ── User store ────────────────────────────────────────────────────────────────
// We only store safe, non-sensitive user profile data (no tokens).
// This is used for UI display (name, avatar, badge) — not for authentication.
// Actual auth is enforced by the HTTP-only cookie on every request.
const TokenManager = {
    // Token methods are gone — cookies are managed entirely by the browser.
    // These stubs are kept so any callers that still check them don't throw.
    getAccessToken:  () => null,
    getRefreshToken: () => null,
    setTokens:       () => {},          // no-op — tokens go into cookies, not here
    clearTokens() {
        localStorage.removeItem('user');
        try { sessionStorage.removeItem('ff_plan_cache_v2'); } catch (_) {}
    },
    getUser() {
        try {
            const u = localStorage.getItem('user');
            return u ? JSON.parse(u) : null;
        } catch (_) { return null; }
    },
    setUser(user) {
        try { localStorage.setItem('user', JSON.stringify(user)); } catch (_) {}
    },
};

// ── Loading overlay ───────────────────────────────────────────────────────────
const LoadingManager = {
    show: (message = 'Loading...') => {
        let loader = document.getElementById('global-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'global-loader';
            loader.innerHTML = `
                <div class="loader-backdrop">
                    <div class="loader-content">
                        <div class="loader-spinner"></div>
                        <p class="loader-message">${message}</p>
                    </div>
                </div>`;
            document.body.appendChild(loader);
        } else {
            const msg = loader.querySelector('.loader-message');
            if (msg) msg.textContent = message;
        }
        loader.style.display = 'flex';
    },
    hide: () => {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    },
};

// ── Toast notifications ───────────────────────────────────────────────────────
const Toast = {
    show: (message, type = 'info', duration = 18000) => {
        // Restack existing toasts
        const existing = document.querySelectorAll('.toast');
        let offset = 20;
        existing.forEach(t => { offset += t.offsetHeight + 10; });

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.style.top = `${offset}px`;
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-icon">${Toast.getIcon(type)}</span>
                <span class="toast-message" style="flex:1;line-height:1.45">${message}</span>
                <button class="toast-dismiss" aria-label="Dismiss"
                    style="background:none;border:none;color:inherit;cursor:pointer;padding:0 0 0 0.75rem;font-size:1.1rem;opacity:0.55;line-height:1;flex-shrink:0;align-self:flex-start">✕</button>
            </div>
            <div class="toast-progress">
                <div class="toast-progress-bar" style="animation:toastProgress ${duration}ms linear forwards"></div>
            </div>`;

        document.body.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-show')));

        function dismiss() {
            clearTimeout(autoTimer);
            toast.classList.remove('toast-show');
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 600);
        }

        toast.querySelector('.toast-dismiss').addEventListener('click', dismiss);
        const autoTimer = setTimeout(dismiss, duration);
        toast._dismiss = dismiss;
    },
    getIcon: (type) => ({ success: '✓', error: '✕', warning: '⚠', info: 'ℹ' }[type] || 'ℹ'),
    success: (msg, duration) => Toast.show(msg, 'success', duration),
    error:   (msg, duration) => Toast.show(msg, 'error',   duration),
    warning: (msg, duration) => Toast.show(msg, 'warning', duration),
    info:    (msg, duration) => Toast.show(msg, 'info',    duration),
};

// ── Core request function ─────────────────────────────────────────────────────
// credentials:'include' makes the browser attach the ff_access cookie automatically.
// No Authorization header is needed — the server reads the cookie.
async function apiRequest(endpoint, options = {}) {
    const url = `${API_CONFIG.baseURL}${endpoint}`;
    // Only set Content-Type when there is a body — GET/HEAD must not carry it
    // (triggers unnecessary CORS preflight on servers with restrictive policies)
    const headers = { ...options.headers };
    if (options.body !== undefined && options.body !== null) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    const controller = new AbortController();
    const _timer = setTimeout(() => controller.abort(), API_CONFIG.timeout);

    const config = {
        ...options,
        headers,
        credentials: 'include',   // ← send ff_access cookie with every request
        signal: controller.signal,
    };

    try {
        let response = await fetch(url, config);
        clearTimeout(_timer);

        if (response.status === 401) {
            // Access cookie expired — try to silently refresh
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                // New ff_access cookie is now set; retry the original request
                response = await fetch(url, { ...config, signal: undefined });
            } else {
                // Refresh failed — session is truly over
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired. Please login again.');
            }
        }

        return await handleResponse(response);
    } catch (error) {
        clearTimeout(_timer);
        if (error.name === 'AbortError')  throw new Error('Request timed out. Server may be starting up — try again.');
        if (error.name === 'TypeError')   throw new Error('Network error. Check your connection.');
        throw error;
    }
}

async function handleResponse(response) {
    // Use text() first — response.json() throws on empty 304 bodies
    const text = await response.text();
    let data = {};
    try { if (text) data = JSON.parse(text); } catch { /* keep {} */ }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
// The ff_refresh cookie is sent automatically by credentials:'include'.
// The server validates it, rotates the pair, and sets new cookies.
// Nothing is returned in the response body — the new ff_access cookie
// is what enables the retry in apiRequest.
let _refreshPromise = null;  // concurrency lock — prevents parallel refresh storms

async function refreshAccessToken() {
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = (async () => {
        try {
            const response = await fetch(`${API_CONFIG.baseURL}/auth/refresh`, {
                method:      'POST',
                headers:     { 'Content-Type': 'application/json' },
                credentials: 'include',   // ← sends ff_refresh cookie
            });
            if (!response.ok) return false;

            const data = await response.json();
            if (data.success) {
                // Server has set fresh ff_access + ff_refresh cookies.
                // Update stored user data if server returned it.
                if (data.data?.user) TokenManager.setUser(data.data.user);
                return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            _refreshPromise = null;
        }
    })();

    return _refreshPromise;
}

// ── AUTH API ──────────────────────────────────────────────────────────────────
const AuthAPI = {
    register: async (userData) => {
        const { name, email, password } = userData;
        const data = await apiRequest('/auth/register', {
            method: 'POST',
            body:   JSON.stringify({ name, email, password }),
        });
        // Cookies are set by the server — we only store user profile data
        if (data.success && data.data?.user) {
            TokenManager.setUser(data.data.user);
        }
        return data;
    },

    login: async (email, password) => {
        const data = await apiRequest('/auth/login', {
            method: 'POST',
            body:   JSON.stringify({ email, password }),
        });
        // Cookies are set by the server — we only store user profile data
        if (data.success && data.data?.user) {
            TokenManager.setUser(data.data.user);
        }
        return data;
    },

    logout: async () => {
        try {
            // POST to logout — server deletes the refresh token from DB and clears cookies
            await fetch(`${API_CONFIG.baseURL}/auth/logout`, {
                method:      'POST',
                headers:     { 'Content-Type': 'application/json' },
                credentials: 'include',
            });
        } catch (e) {
            console.error('Logout error:', e);
        } finally {
            // Always clear local user data regardless of network outcome
            TokenManager.clearTokens();
            window.location.href = 'index.html';
        }
    },

    getCurrentUser: async () => await apiRequest('/auth/me'),

    changePassword: async (currentPassword, newPassword) =>
        await apiRequest('/auth/change-password', {
            method: 'POST',
            body:   JSON.stringify({ currentPassword, newPassword }),
        }),
};

// ── WORKOUTS API ──────────────────────────────────────────────────────────────
const WorkoutsAPI = {
    getExercises: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        const res = await apiRequest(`/exercises?${params}`);
        if (res && res.success) {
            const d = res.data;
            if      (Array.isArray(d))             res.data = d;
            else if (Array.isArray(d?.exercises))  res.data = d.exercises;
            else if (Array.isArray(d?.data))       res.data = d.data;
            else if (Array.isArray(d?.items))      res.data = d.items;
            else res.data = [];
        }
        return res;
    },
    searchExercises: async (query) => {
        try {
            const r = await apiRequest(`/exercises/search?q=${encodeURIComponent(query)}`);
            if (r && r.success) {
                if (Array.isArray(r.data?.exercises)) r.data = r.data.exercises;
                else if (!Array.isArray(r.data))      r.data = [];
                return r;
            }
        } catch {}
        const r2 = await apiRequest(`/exercises?search=${encodeURIComponent(query)}&limit=50`);
        if (r2 && r2.success) {
            if (Array.isArray(r2.data?.exercises)) r2.data = r2.data.exercises;
            else if (!Array.isArray(r2.data))      r2.data = [];
        }
        return r2;
    },
    getExerciseById: async (id) => {
        const r = await apiRequest(`/exercises/${id}`);
        if (r && r.success && r.data?.exercise) r.data = r.data.exercise;
        return r;
    },
};

// ── PROGRAMS API ──────────────────────────────────────────────────────────────
const ProgramsAPI = {
    getPrograms:     async (filters = {}) => await apiRequest(`/programs?${new URLSearchParams(filters)}`),
    getProgramById:  async (id) => await apiRequest(`/programs/${id}`),
    enrollInProgram: async (programId) => await apiRequest(`/programs/${programId}/enroll`, { method: 'POST' }),
    getUserPrograms: async () => await apiRequest('/programs/my-enrollments'),
    updateProgress:  async (enrollmentId, data) => await apiRequest(
        `/programs/enrollments/${enrollmentId}/progress`,
        { method: 'PUT', body: JSON.stringify(data) }
    ),
};

// ── PROGRESS API ──────────────────────────────────────────────────────────────
const ProgressAPI = {
    logWorkout: async (workoutData) => {
        const { exerciseId, duration, sets, reps, caloriesBurned, heartRate, difficulty, notes } = workoutData;
        return await apiRequest('/progress', {
            method: 'POST',
            body:   JSON.stringify({
                exerciseId,
                duration:       parseInt(duration),
                sets:           sets           ? parseInt(sets)           : undefined,
                reps:           reps           ? parseInt(reps)           : undefined,
                caloriesBurned: caloriesBurned ? parseFloat(caloriesBurned) : undefined,
                heartRate:      heartRate      ? parseInt(heartRate)      : undefined,
                difficulty,
                notes,
            }),
        });
    },
    getUserProgress:   async ()             => await apiRequest('/progress/me'),
    getStats:          async (period='30d') => await apiRequest(`/progress/stats?period=${period}`),
    getWorkoutHistory: async (limit=20)     => await apiRequest(`/progress/history?limit=${limit}`),
    getStreaks:        async ()             => await apiRequest('/progress/streaks'),
    getAchievements:   async () => {
        const r = await apiRequest('/progress/achievements');
        if (r && r.success) {
            const d = r.data;
            if      (Array.isArray(d))               r.data = d;
            else if (Array.isArray(d?.achievements)) r.data = d.achievements;
            else if (Array.isArray(d?.data))         r.data = d.data;
            else if (d?.unlocked || d?.locked) {
                const ul = (d.unlocked||[]).map(a => ({...a, unlocked:true}));
                const lk = (d.locked  ||[]).map(a => ({...a, unlocked:false}));
                r.data = [...ul, ...lk];
            } else r.data = [];
        }
        return r;
    },
    recalculateAchievements: async () => {
        // POST — backend evaluates requirements against DB and upserts UserAchievement rows,
        // then returns the full achievement list with server-verified unlocked flags.
        const r = await apiRequest('/progress/achievements/recalculate', { method: 'POST' });
        if (r && r.success && Array.isArray(r.data)) return r;
        // Fallback normalise
        const raw = r?.data ?? r;
        let items = [];
        if (Array.isArray(raw)) items = raw;
        else if (Array.isArray(raw?.data)) items = raw.data;
        return { success: true, data: items };
    },
};

// ── USERS API ─────────────────────────────────────────────────────────────────
const UserAPI = {
    getProfile:        async ()            => await apiRequest('/users/me'),
    updateProfile:     async (profileData) => await apiRequest('/users/me', { method:'PUT', body:JSON.stringify(profileData) }),
    updateMetrics:     async (metrics)     => await apiRequest('/users/metrics', { method:'POST', body:JSON.stringify(metrics) }),
    getMetricsHistory: async (limit=30)    => await apiRequest(`/users/metrics/history?limit=${limit}`),
};

// ── SUBSCRIPTIONS API ─────────────────────────────────────────────────────────
const SubscriptionAPI = {
    getPlans: async () => {
        const res = await apiRequest('/subscriptions/plans');
        if (res && Array.isArray(res.plans)) return { success: true, data: res.plans };
        if (res && res.success && Array.isArray(res.data)) return res;
        return { success: false, data: [] };
    },
    getCurrentSubscription: async () => {
        const res = await apiRequest('/subscriptions/current');
        if (res && 'subscription' in res) return { success: true, data: res.subscription };
        if (res && res.success !== undefined) return res;
        return { success: false, data: null };
    },
    createCheckoutSession: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.checkoutUrl) return { success: true, data: { url: res.checkoutUrl, sessionId: res.sessionId } };
        if (res && res.success) return res;
        return res;
    },
    createStripeCheckout: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.checkoutUrl) return { success: true, data: { url: res.checkoutUrl, sessionId: res.sessionId } };
        if (res && res.success) return res;
        return res;
    },
    upgradePlan: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/upgrade', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },
    downgradePlan: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/downgrade', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },
    cancelSubscription: async (immediately = false, reason) => {
        const res = await apiRequest('/subscriptions/cancel', {
            method: 'POST',
            body:   JSON.stringify({ immediately, ...(reason ? { reason } : {}) }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },
    reactivateSubscription: async () => {
        const res = await apiRequest('/subscriptions/reactivate', { method: 'POST' });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },
    getBillingPortalUrl: async () => await apiRequest('/subscriptions/billing-portal'),
    initMpesaPayment:    async (planId, phone, interval = 'MONTHLY') =>
        await apiRequest('/subscriptions/mpesa/initiate', {
            method: 'POST', body: JSON.stringify({ planId, phone, interval }),
        }),
    checkMpesaStatus: async (checkoutRequestId) =>
        await apiRequest(`/subscriptions/mpesa/status/${checkoutRequestId}`),
};

// ── LIVE PLAN UTILITIES ───────────────────────────────────────────────────────
const FREE_PLAN_DEFAULTS = {
    slug: 'free', name: 'Free',
    maxWorkoutsPerMonth: 10, maxPrograms: 1,
    hasAdvancedAnalytics: false, hasPersonalCoaching: false,
    hasNutritionTracking: false, hasOfflineAccess: false,
};
const PLAN_HIERARCHY = { free: 0, pro: 1, elite: 2 };

async function fetchActivePlan() {
    const CACHE_KEY = 'ff_plan_cache_v2';
    const CACHE_TTL = 5 * 60 * 1000;
    try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
            const { ts, plan, sub } = JSON.parse(cached);
            if (Date.now() - ts < CACHE_TTL) return { plan, sub };
        }
    } catch {}
    try {
        const res  = await SubscriptionAPI.getCurrentSubscription();
        const sub  = res?.data || null;
        const isActive = sub && ['ACTIVE','TRIALING','PAST_DUE'].includes(sub.status);
        const plan = isActive && sub.plan ? sub.plan : FREE_PLAN_DEFAULTS;
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), plan, sub })); } catch {}
        return { plan, sub };
    } catch {
        return { plan: FREE_PLAN_DEFAULTS, sub: null };
    }
}

function invalidatePlanCache() {
    try { sessionStorage.removeItem('ff_plan_cache_v2'); } catch {}
}

function showUpgradePrompt(featureName, minPlan = 'pro') {
    const planLabel = minPlan === 'elite' ? '👑 Elite' : '⚡ Pro';
    const ex = document.getElementById('ff-upgrade-gate');
    if (ex) ex.remove();
    const el = document.createElement('div');
    el.id = 'ff-upgrade-gate';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(8px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:1.5rem';
    el.innerHTML = `
        <div style="background:linear-gradient(145deg,#13131a,#1c1c28);border:1px solid rgba(212,175,55,0.35);border-radius:22px;padding:2.5rem 2rem;max-width:400px;width:100%;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,0.7)">
            <div style="font-size:3rem;margin-bottom:1rem">🔒</div>
            <h3 style="font-family:'Oswald',sans-serif;font-size:1.6rem;letter-spacing:1px;color:#fff;margin-bottom:.6rem">${featureName}</h3>
            <p style="color:#888;font-size:.92rem;line-height:1.6;margin-bottom:1.5rem">
                This feature is available on <strong style="color:#D4AF37">${planLabel}</strong> and above.<br>
                Upgrade to unlock unlimited access and more.
            </p>
            <a href="subscription.html" style="display:block;width:100%;padding:.95rem;background:linear-gradient(135deg,#D4AF37 0%,#edcf7d 50%,#b8860b 100%);color:#000;font-weight:800;font-family:'Oswald',sans-serif;letter-spacing:2px;border-radius:12px;text-decoration:none;font-size:1rem;margin-bottom:.75rem">
                🚀 UPGRADE TO ${minPlan.toUpperCase()}
            </a>
            <button onclick="document.getElementById('ff-upgrade-gate').remove()" style="width:100%;padding:.75rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:12px;cursor:pointer;font-family:'Inter',sans-serif;font-size:.9rem">
                Maybe Later
            </button>
        </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
}

async function updatePlanBadge() {
    const badge = document.getElementById('planBadge');
    if (!badge) return;
    try {
        const { plan, sub } = await fetchActivePlan();
        if (!sub || ['CANCELLED','EXPIRED','INCOMPLETE_EXPIRED'].includes(sub.status)) {
            badge.textContent = 'FREE';
            badge.className   = 'plan-badge plan-free';
            return;
        }
        const slug    = plan?.slug || 'free';
        const isTrial = sub.status === 'TRIALING';
        const BADGE_MAP = {
            free:  { cls: 'plan-free',  label: 'FREE' },
            pro:   { cls: 'plan-pro',   label: isTrial ? '⏳ PRO TRIAL'   : '⚡ PRO' },
            elite: { cls: 'plan-elite', label: isTrial ? '⏳ ELITE TRIAL' : '👑 ELITE' },
        };
        const { cls, label } = BADGE_MAP[slug] || BADGE_MAP.free;
        badge.textContent = label;
        badge.className   = 'plan-badge ' + cls;
    } catch {}
}

// ── PLAN DETECTION HELPERS ────────────────────────────────────────────────────
function getUserPlan() {
    const user = TokenManager.getUser();
    const sub  = user?.subscriptionData || user?.subscription || {};
    const plan = typeof sub === 'string' ? sub : (sub.plan || sub.type || sub.status || user?.role || 'FREE');
    return String(plan).toUpperCase();
}
function isPlanAtLeast(minPlan) {
    const order   = ['FREE','TRIAL','PRO','PREMIUM','ADMIN'];
    const userIdx = order.findIndex(p => getUserPlan().includes(p));
    const minIdx  = order.indexOf(minPlan.toUpperCase());
    return userIdx >= minIdx;
}
function isPremium()   { return isPlanAtLeast('PREMIUM'); }
function isPro()       { return isPlanAtLeast('PRO'); }
function isTrialUser() { return getUserPlan().includes('TRIAL'); }
function isFreeUser()  { const p = getUserPlan(); return p === 'FREE' || !p; }

// ── AUTH UTILITIES ────────────────────────────────────────────────────────────

/**
 * isAuthenticated
 *
 * Checks whether a user profile is stored locally — set during login/register.
 * This is a UI-layer check only; the actual authentication happens server-side
 * via the HTTP-only ff_access cookie on every API request.
 *
 * If the cookie is expired the first protected API call returns 401, which
 * triggers the silent refresh flow in apiRequest(). If refresh also fails,
 * clearTokens() is called and the user is redirected to login.html.
 */
function isAuthenticated() {
    return !!TokenManager.getUser();
}

function requireAuth() {
    if (!isAuthenticated()) {
        // Save the page they were trying to reach so login can redirect back
        try { localStorage.setItem('redirectAfterLogin', window.location.pathname); } catch {}
        window.location.href = 'login.html';
        return false;
    }
    return true;
}

async function checkAuth() {
    if (isAuthenticated()) {
        try {
            const response = await AuthAPI.getCurrentUser();
            if (response.success && response.data) {
                TokenManager.setUser(response.data);
                return response.data;
            }
        } catch (error) {
            console.error('Auth check failed:', error);
            TokenManager.clearTokens();
        }
    }
    return null;
}

function updateNavigation() {
    const user = TokenManager.getUser();
    document.querySelectorAll('.auth-buttons').forEach(container => {
        container.innerHTML = user
            ? `<a href="dashboard.html" class="btn btn-ghost">Dashboard</a>
               <button onclick="handleLogout()" class="btn btn-primary">Logout</button>`
            : `<a href="login.html" class="btn btn-ghost">Login</a>
               <a href="register.html" class="btn btn-primary">Sign Up</a>`;
    });
}

// ── Sidebar badge helpers (standalone functions, no SidebarUser object) ───────

/** Apply badge class + label from a raw plan string (slug, status, or role) */
function _applyBadgeFromStr(raw) {
    const s = String(raw || '').toUpperCase();
    let cls = 'plan-free', label = 'FREE';
    if      (s.includes('ELITE'))                        { cls = 'plan-elite';   label = 'ELITE'; }
    else if (s.includes('PREMIUM'))                      { cls = 'plan-premium'; label = 'PREMIUM'; }
    else if (s.includes('PRO'))                          { cls = 'plan-pro';     label = 'PRO'; }
    else if (s.includes('TRIAL') || s === 'TRIALING')   { cls = 'plan-trial';   label = 'TRIAL'; }
    else if (s === 'ADMIN')                              { cls = 'plan-premium'; label = 'ADMIN'; }
    document.querySelectorAll('#planBadge').forEach(el => {
        el.className   = 'plan-badge ' + cls;
        el.textContent = label;
    });
}

/** Fetch the live subscription from the API and keep the badge in sync.
 *  Uses credentials:'include' so the ff_access cookie is sent automatically.
 *  Does NOT go through apiRequest — intentionally fire-and-forget. */
async function _refreshBadgeFromAPI() {
    try {
        const res = await fetch(`${API_CONFIG.baseURL}/subscriptions/current`, {
            credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json();
        const sub  = data?.subscription ?? data?.data?.subscription ?? data?.data ?? data;
        if (!sub) return;
        const status = (sub?.status || '').toUpperCase();
        if      (['CANCELLED','EXPIRED','INACTIVE'].includes(status)) _applyBadgeFromStr('FREE');
        else if (status === 'TRIALING')                               _applyBadgeFromStr('TRIAL');
        else {
            const slug = sub?.plan?.slug || sub?.planSlug || '';
            if (slug) _applyBadgeFromStr(slug);
        }
    } catch (_) { /* silent — badge stays as token value */ }
}

function populateSidebarUser() {
    const user = TokenManager.getUser();
    if (!user) return;
    const name     = user.name || user.email || 'User';
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = initials; });
    document.querySelectorAll('#userName').forEach(el => { el.textContent = name; });
    document.querySelectorAll('.user-info h4').forEach(el => { el.textContent = name; });

    // Apply badge immediately from stored data (no flicker), then refresh from API
    _applyBadgeFromStr(user?.subscription || user?.subscriptionData?.plan || user?.role || 'FREE');
    _refreshBadgeFromAPI();
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout() {
    LoadingManager.show('Logging out...');
    await AuthAPI.logout();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '0m';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

// ── Global error recovery ─────────────────────────────────────────────────────
window.addEventListener('unhandledrejection', () => {
    try { LoadingManager.hide(); } catch (_) {}
});
window.onerror = () => {
    try { LoadingManager.hide(); } catch (_) {}
};

// ── DOMContentLoaded — inject global styles + initialise navigation ───────────
document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('global-styles')) {
        const styles = document.createElement('style');
        styles.id = 'global-styles';
        styles.textContent = `
            #global-loader { display:none; position:fixed; top:0; left:0; width:100%; height:100%; z-index:10000; }
            .loader-backdrop { position:absolute; width:100%; height:100%; background:rgba(0,0,0,0.8); backdrop-filter:blur(5px); display:flex; align-items:center; justify-content:center; }
            .loader-content { background:var(--bg-elevated,#121218); padding:2rem 3rem; border-radius:20px; text-align:center; border:1px solid rgba(212,175,55,0.25); box-shadow:0 0 30px rgba(212,175,55,0.1); }
            .loader-spinner { width:50px; height:50px; border:4px solid rgba(255,255,255,0.1); border-top-color:var(--gold-primary,#D4AF37); border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 1rem; }
            @keyframes spin { to { transform:rotate(360deg); } }
            .loader-message { color:var(--text-primary,#fff); font-size:1rem; }
            .toast { position:fixed; right:20px; padding:1rem 1.5rem 0.75rem; border-radius:14px; background:var(--bg-card,#1a1a24); border:1px solid rgba(255,255,255,0.1); box-shadow:0 12px 40px rgba(0,0,0,0.6); z-index:9999; transform:translateX(calc(100% + 40px)); opacity:0; transition:transform 0.5s cubic-bezier(0.34,1.56,0.64,1), opacity 0.4s ease; min-width:300px; max-width:360px; overflow:hidden; }
            .toast-show { transform:translateX(0); opacity:1; }
            .toast-progress { position:absolute; bottom:0; left:0; height:3px; width:100%; transform-origin:left; background:rgba(255,255,255,0.25); border-radius:0 0 14px 14px; }
            .toast-progress-bar { height:100%; width:100%; transform-origin:left; border-radius:0 0 14px 14px; }
            .toast-success .toast-progress-bar { background:#4ade80; }
            .toast-error   .toast-progress-bar { background:#f87171; }
            .toast-warning .toast-progress-bar { background:#fbbf24; }
            .toast-info    .toast-progress-bar { background:#60a5fa; }
            .toast-content { display:flex; align-items:center; gap:1rem; color:var(--text-primary,#fff); }
            .toast-icon { width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; }
            .toast-success .toast-icon { background:#4ade80; color:#000; }
            .toast-error   .toast-icon { background:#f87171; color:#000; }
            .toast-warning .toast-icon { background:#fbbf24; color:#000; }
            .toast-info    .toast-icon { background:#60a5fa; color:#000; }
            @keyframes toastProgress { from { transform:scaleX(1); } to { transform:scaleX(0); } }
            .log-workout-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); backdrop-filter:blur(10px); z-index:2000; align-items:center; justify-content:center; padding:2rem; }
            .log-workout-modal.active { display:flex; }
            .log-modal-box { background:var(--bg-card,#1a1a24); border-radius:20px; padding:2.5rem; width:100%; max-width:480px; border:1px solid rgba(255,255,255,0.08); }
            .log-modal-box h3 { font-size:1.5rem; margin-bottom:1.5rem; }
            .log-field { margin-bottom:1.2rem; }
            .log-field label { display:block; font-weight:600; margin-bottom:0.4rem; font-size:0.9rem; color:#a8a8b8; }
            .log-field input, .log-field select { width:100%; padding:0.85rem 1rem; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); border-radius:10px; color:#fff; font-family:inherit; font-size:1rem; }
            .log-field input:focus, .log-field select:focus { outline:none; border-color:#f5576c; }
            .log-row { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
            .log-actions { display:flex; gap:1rem; margin-top:1.5rem; }
            .log-actions button { flex:1; padding:0.9rem; border-radius:10px; border:none; font-weight:700; font-size:1rem; cursor:pointer; font-family:inherit; }
            .btn-log-submit { background:linear-gradient(135deg,#D4AF37 0%,#F2D479 50%,#B8860B 100%); color:#000; }
            .btn-log-cancel { background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.08) !important; }
        `;
        document.head.appendChild(styles);
    }
    updateNavigation();
    populateSidebarUser();

    // Cross-page achievement toast
    window.addEventListener('storage', (e) => {
        if (e.key === 'ff_new_achievement') {
            try {
                const a = JSON.parse(e.newValue || 'null');
                if (!a || !a.name) return;
                Toast.show(
                    `🏆 Achievement unlocked: <strong>${a.name}</strong> · +${a.points || 0} pts`,
                    'success', 6000
                );
                localStorage.removeItem('ff_new_achievement');
            } catch (_) {}
        }
    });
});
