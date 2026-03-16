/**
 * FlowFit API Client — Fixed version
 * Bugs fixed: #1 workout filters, #2 program filters, #3 formatDuration (minutes not seconds)
 */

const API_CONFIG = {
    baseURL: 'https://fit.cctamcc.site/api/v1',
    timeout: 30000,
};

const TokenManager = {
    getAccessToken:  () => localStorage.getItem('accessToken'),
    getRefreshToken: () => localStorage.getItem('refreshToken'),
    setTokens: (accessToken, refreshToken) => {
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);
    },
    clearTokens: () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
    },
    getUser: () => {
        const u = localStorage.getItem('user');
        return u ? JSON.parse(u) : null;
    },
    setUser: (user) => localStorage.setItem('user', JSON.stringify(user)),
};

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

const Toast = {
    show: (message, type = 'info', duration = 18000) => {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
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

        // Use #toastArea if available (handles layout/stacking via flex-column)
        // Fall back to document.body with fixed positioning
        const area = document.getElementById('toastArea');
        if (area) {
            area.appendChild(toast);
        } else {
            toast.style.position = 'fixed';
            toast.style.top = '5rem';
            toast.style.right = '1.2rem';
            toast.style.zIndex = '99999';
            document.body.appendChild(toast);
        }

        // Slide in — small delay so browser registers the initial transform before transition
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-show')));

        function dismiss() {
            clearTimeout(autoTimer);
            toast.classList.remove('toast-show');
            // Wait for slide-out transition to finish before removing (0.5s slide + buffer)
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

async function apiRequest(endpoint, options = {}) {
    const url = `${API_CONFIG.baseURL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = TokenManager.getAccessToken();
    if (token && url.startsWith(API_CONFIG.baseURL))
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const controller = new AbortController();
    const _timer = setTimeout(() => controller.abort(), API_CONFIG.timeout || 15000);
    const config = { ...options, headers, signal: controller.signal };
    try {

        if (!window.location.pathname.includes('login.html')) { window.location.href = 'login.html'; }
        let response = await fetch(url, config);
        clearTimeout(_timer);
        if (response.status === 401 && token) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
                response = await fetch(url, { ...config, headers });
            } else {
                // Only force logout if this is NOT a background/non-critical call.
                // Avoid nuking the session on a transient network failure.
                // Check if we still have a refresh token — if so, maybe it was
                // a race condition and another call already refreshed.
                const stillHasToken = TokenManager.getAccessToken();
                if (stillHasToken) {
                    // Another parallel call refreshed — retry with the new token
                    headers['Authorization'] = `Bearer ${stillHasToken}`;
                    response = await fetch(url, { ...config, headers });
                } else {
                    TokenManager.clearTokens();
                    window.location.href = 'login.html';
                    throw new Error('Session expired. Please login again.');
                }
            }
        }
        return await handleResponse(response);
    } catch (error) {
        clearTimeout(_timer);
        if (error.name === 'AbortError') throw new Error('Request timed out. Server may be starting up — try again.');
        if (error.name === 'TypeError') throw new Error('Network error. Check your connection.');
        throw error;
    }
}

async function handleResponse(response) {
    // Use text() first — response.json() throws SyntaxError on empty bodies,
    // which happens when the server sends 304 Not Modified with no body
    // (common when Authorization header prevents browser caching on public routes).
    // SyntaxError is not caught by the TypeError guard in apiRequest, so it
    // silently breaks every call. text()→JSON.parse is always safe.
    const text = await response.text();
    let data = {};
    try { if (text) data = JSON.parse(text); } catch { /* non-JSON body, keep {} */ }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
}

// ── Token refresh with concurrency lock ──────────────────────────────────────
// Prevents race condition: if 4 API calls all 401 simultaneously, only ONE
// refresh request fires. The rest wait for its result.
let _refreshPromise = null;

async function refreshAccessToken() {
    // If a refresh is already in-flight, wait for it instead of firing another
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = (async () => {
        try {
            const refreshToken = TokenManager.getRefreshToken();
            if (!refreshToken) return false;
            const response = await fetch(`${API_CONFIG.baseURL}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });
            if (!response.ok) return false;
            const data = await response.json();
            if (data.success && data.data) {
                TokenManager.setTokens(data.data.accessToken, data.data.refreshToken);
                return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            // Release lock so future calls can refresh again
            _refreshPromise = null;
        }
    })();

    return _refreshPromise;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
const AuthAPI = {
    register: async (userData) => {
        const { name, email, password } = userData;
        const data = await apiRequest('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, password }),
        });
        if (data.success && data.data) {
            TokenManager.setTokens(data.data.accessToken, data.data.refreshToken);
            TokenManager.setUser(data.data.user);
        }
        return data;
    },
    login: async (email, password) => {
        const data = await apiRequest('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        if (data.success && data.data) {
            TokenManager.setTokens(data.data.accessToken, data.data.refreshToken);
            TokenManager.setUser(data.data.user);
        }
        return data;
    },
    logout: async () => {
        try {
            const refreshToken = TokenManager.getRefreshToken();
            if (refreshToken) {
                await apiRequest('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
            }
        } catch (e) { console.error('Logout error:', e); }
        finally {
            TokenManager.clearTokens();
            window.location.href = 'index.html';
        }
    },
    getCurrentUser: async () => await apiRequest('/auth/me'),
    changePassword: async (currentPassword, newPassword) => await apiRequest('/auth/change-password', {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

// ── WORKOUTS ──────────────────────────────────────────────────────────────────
// FIX #1: Pass ALL filters — backend supports category, difficulty, muscle, equipment, limit, page
const WorkoutsAPI = {
    getExercises: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        const res = await apiRequest(`/exercises?${params}`);
        if (res && res.success) {
            const d = res.data;
            if      (Array.isArray(d))               res.data = d;
            else if (Array.isArray(d?.exercises))    res.data = d.exercises;
            else if (Array.isArray(d?.data))         res.data = d.data;
            else if (Array.isArray(d?.items))        res.data = d.items;
            else res.data = [];
        }
        return res;
    },
    searchExercises: async (query) => {
        
            const r = await apiRequest(`/exercises/search?q=${encodeURIComponent(query)}`);
            if (r && r.success) {
                if (Array.isArray(r.data?.exercises)) r.data = r.data.exercises;
                else if (!Array.isArray(r.data))      r.data = [];
                return r;
            }
        
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

// ── PROGRAMS ──────────────────────────────────────────────────────────────────
// FIX #2: Pass ALL filters — backend supports difficulty, category, isPremium, limit, page
const ProgramsAPI = {
    getPrograms: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        return await apiRequest(`/programs?${params}`);
    },
    getProgramById: async (id) => await apiRequest(`/programs/${id}`),
    enrollInProgram: async (programId) => await apiRequest(`/programs/${programId}/enroll`, { method: 'POST' }),
    getUserPrograms: async () => await apiRequest('/programs/my-enrollments'),
    updateProgress: async (enrollmentId, data) => await apiRequest(`/programs/enrollments/${enrollmentId}/progress`, {
        method: 'PUT', body: JSON.stringify(data),
    }),
};

;

// ── PROGRESS ──────────────────────────────────────────────────────────────────
const ProgressAPI = {
    // duration MUST be in MINUTES (integer) — that is how WorkoutLog stores it in the DB
    logWorkout: async (workoutData) => {
        const { exerciseId, duration, sets, reps, caloriesBurned, heartRate, difficulty, notes } = workoutData;
        return await apiRequest('/progress', {
            method: 'POST',
            body: JSON.stringify({
                exerciseId,
                duration:      parseInt(duration),     // minutes — do NOT multiply by 60
                sets:          sets          ? parseInt(sets)          : undefined,
                reps:          reps          ? parseInt(reps)          : undefined,
                caloriesBurned: caloriesBurned ? parseFloat(caloriesBurned) : undefined,
                heartRate:     heartRate     ? parseInt(heartRate)     : undefined,
                difficulty,
                notes,
            }),
        });
    },
    getUserProgress:   async ()              => await apiRequest('/progress/me'),
    getStats:          async (period='30d')  => await apiRequest(`/progress/stats?period=${period}`),
    getWorkoutHistory: async (limit=20)      => await apiRequest(`/progress/history?limit=${limit}`),
    getStreaks:        async ()              => await apiRequest('/progress/streaks'),
    getAchievements: async () => {
        const r = await apiRequest('/progress/achievements');
        // Normalise every possible shape the backend may return
        const raw = r?.data ?? r;
        let items = [];
        if      (Array.isArray(raw))                 items = raw;
        else if (Array.isArray(raw?.achievements))   items = raw.achievements;
        else if (Array.isArray(raw?.data))           items = raw.data;
        else if (raw?.unlocked || raw?.locked) {
            const ul = (raw.unlocked||[]).map(a => ({...a, unlocked:true}));
            const lk = (raw.locked  ||[]).map(a => ({...a, unlocked:false}));
            items = [...ul, ...lk];
        }
        return { success: true, data: items };
    },
    // Recalculate achievements server-side for current user — handles historical workouts
    recalculateAchievements: async () => {
        const r = await apiRequest('/progress/achievements/recalculate');
        const raw = r?.data ?? r;
        let items = [];
        if (Array.isArray(raw)) items = raw;
        else if (Array.isArray(raw?.data)) items = raw.data;
        return { success: true, data: items };
    },
};

// ── USERS ─────────────────────────────────────────────────────────────────────
const UserAPI = {
    getProfile:        async ()             => await apiRequest('/users/me'),
    updateProfile:     async (profileData)  => await apiRequest('/users/me', { method:'PUT', body:JSON.stringify(profileData) }),
    updateMetrics:     async (metrics)      => await apiRequest('/users/metrics', { method:'POST', body:JSON.stringify(metrics) }),
    getMetricsHistory: async (limit=30)     => await apiRequest(`/users/metrics/history?limit=${limit}`),
};

// ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────────
const SubscriptionAPI = {

    // GET /subscriptions/plans — public, no auth required
    // Returns { plans: [...] } — normalise to { success, data: Plan[] }
    getPlans: async () => {
        const res = await apiRequest('/subscriptions/plans');
        if (res && Array.isArray(res.plans)) return { success: true, data: res.plans };
        if (res && res.success && Array.isArray(res.data)) return res;
        return { success: false, data: [] };
    },

    // GET /subscriptions/current — returns { subscription: CurrentSubscription | null }
    // Normalise to { success, data: CurrentSubscription | null }
    getCurrentSubscription: async () => {
        const res = await apiRequest('/subscriptions/current');
        if (res && 'subscription' in res) return { success: true, data: res.subscription };
        if (res && res.success !== undefined) return res;
        return { success: false, data: null };
    },

    // POST /subscriptions/checkout — planId MUST be a real DB UUID, interval MUST be 'MONTHLY'|'YEARLY'
    // Returns { checkoutUrl, sessionId } — normalise to { success, data: { url, sessionId } }
    createCheckoutSession: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST',
            body: JSON.stringify({ planId, interval }),
        });
        if (res && res.checkoutUrl) return { success: true, data: { url: res.checkoutUrl, sessionId: res.sessionId } };
        if (res && res.success) return res;
        return res;
    },

    // Alias — same /checkout endpoint, same body, same response
    createStripeCheckout: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST',
            body: JSON.stringify({ planId, interval }),
        });
        if (res && res.checkoutUrl) return { success: true, data: { url: res.checkoutUrl, sessionId: res.sessionId } };
        if (res && res.success) return res;
        return res;
    },

    // POST /subscriptions/upgrade — immediate plan change (prorated), requires active sub
    upgradePlan: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/upgrade', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },

    // POST /subscriptions/downgrade — scheduled for next billing cycle
    downgradePlan: async (planId, interval = 'MONTHLY') => {
        const res = await apiRequest('/subscriptions/downgrade', {
            method: 'POST', body: JSON.stringify({ planId, interval }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },

    // POST /subscriptions/cancel — { immediately?: bool, reason?: string }
    cancelSubscription: async (immediately = false, reason) => {
        const res = await apiRequest('/subscriptions/cancel', {
            method: 'POST',
            body: JSON.stringify({ immediately, ...(reason ? { reason } : {}) }),
        });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },

    // POST /subscriptions/reactivate — undo a scheduled cancellation
    reactivateSubscription: async () => {
        const res = await apiRequest('/subscriptions/reactivate', { method: 'POST' });
        if (res && res.subscription) return { success: true, data: res.subscription };
        return res;
    },

    // GET /subscriptions/billing-portal — returns { url }
    getBillingPortalUrl: async () => await apiRequest('/subscriptions/billing-portal'),

    // M-Pesa STK Push — planId must be a real UUID
    initMpesaPayment: async (planId, phone, interval = 'MONTHLY') => await apiRequest('/subscriptions/mpesa/initiate', {
        method: 'POST',
        body: JSON.stringify({ planId, phone, interval }),
    }),

    // Poll M-Pesa payment status
    checkMpesaStatus: async (checkoutRequestId) => await apiRequest(`/subscriptions/mpesa/status/${checkoutRequestId}`),
};

// ── LIVE PLAN UTILITIES ───────────────────────────────────────────────────────

// FREE plan defaults — safe fallback if API is unreachable
const FREE_PLAN_DEFAULTS = {
    slug: 'free', name: 'Free',
    maxWorkoutsPerMonth: 10, maxPrograms: 1,
    hasAdvancedAnalytics: false, hasPersonalCoaching: false,
    hasNutritionTracking: false, hasOfflineAccess: false,
};
const PLAN_HIERARCHY = { free: 0, pro: 1, elite: 2 };

/**
 * Fetch the user's current active plan from the API.
 * Caches result in sessionStorage for 5 minutes to avoid hammering the server.
 * Returns a plan object (always has slug, maxWorkoutsPerMonth, etc.)
 * Also returns the full subscription for status checks.
 */
async function fetchActivePlan() {
    const CACHE_KEY = 'ff_plan_cache_v2';
    const CACHE_TTL = 5 * 60 * 1000; // 5 min
    try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
            const { ts, plan, sub } = JSON.parse(cached);
            if (Date.now() - ts < CACHE_TTL) return { plan, sub };
        }
    } catch {}

    try {
        const res = await SubscriptionAPI.getCurrentSubscription();
        const sub = res?.data || null;
        const activeStatuses = ['ACTIVE', 'TRIALING', 'PAST_DUE'];
        const isActive = sub && activeStatuses.includes(sub.status);
        const plan = isActive && sub.plan ? sub.plan : FREE_PLAN_DEFAULTS;
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), plan, sub }));
        } catch {}
        return { plan, sub };
    } catch {
        return { plan: FREE_PLAN_DEFAULTS, sub: null };
    }
}

/** Invalidate plan cache — call after any subscription change */
function invalidatePlanCache() {
    try { sessionStorage.removeItem('ff_plan_cache_v2'); } catch {}
}

/**
 * Show an "upgrade required" modal.
 * @param {string} featureName  - Human-readable feature name
 * @param {string} minPlan      - 'pro' or 'elite'
 */
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

/**
 * Update sidebar plan badge using live API data.
 * Reads plan.slug from the subscription to show accurate badge.
 */
async function updatePlanBadge() {
    const badge = document.getElementById('planBadge');
    if (!badge) return;
    try {
        const { plan, sub } = await fetchActivePlan();
        if (!sub || ['CANCELLED', 'EXPIRED', 'INCOMPLETE_EXPIRED'].includes(sub.status)) {
            badge.textContent = 'FREE';
            badge.className = 'plan-badge plan-free';
            return;
        }
        const slug = plan?.slug || 'free';
        const isTrial = sub.status === 'TRIALING';
        const BADGE_MAP = {
            free:  { cls: 'plan-free',    label: 'FREE' },
            pro:   { cls: 'plan-pro',     label: isTrial ? '⏳ PRO TRIAL' : '⚡ PRO' },
            elite: { cls: 'plan-elite',   label: isTrial ? '⏳ ELITE TRIAL' : '👑 ELITE' },
        };
        const { cls, label } = BADGE_MAP[slug] || BADGE_MAP.free;
        badge.textContent = label;
        badge.className = 'plan-badge ' + cls;
    } catch {}
}

// ── PLAN DETECTION HELPERS ─────────────────────────────────────────────────────
function getUserPlan() {
    const user = TokenManager.getUser();
    const sub = user?.subscriptionData || user?.subscription || {};
    const plan = typeof sub === 'string' ? sub : (sub.plan || sub.type || sub.status || user?.role || 'FREE');
    return String(plan).toUpperCase();
}
function isPlanAtLeast(minPlan) {
    const order = ['FREE', 'TRIAL', 'PRO', 'PREMIUM', 'ADMIN'];
    const userPlan = getUserPlan();
    const userIdx = order.findIndex(p => userPlan.includes(p));
    const minIdx  = order.indexOf(minPlan.toUpperCase());
    return userIdx >= minIdx;
}
function isPremium()  { return isPlanAtLeast('PREMIUM'); }
function isPro()      { return isPlanAtLeast('PRO'); }
function isTrialUser(){ const p=getUserPlan(); return p.includes('TRIAL'); }
function isFreeUser() { const p=getUserPlan(); return p==='FREE'||!p; }


// ── UTILITIES ─────────────────────────────────────────────────────────────────
function isAuthenticated() { return !!TokenManager.getAccessToken(); }

function requireAuth() {
    if (!isAuthenticated()) {
        localStorage.setItem('redirectAfterLogin', window.location.pathname);
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

// FIX #9/#14: Populate sidebar user info from real stored user — call on every dashboard page
function populateSidebarUser() {
    const user = TokenManager.getUser();
    if (!user) return;
    const name = user.name || user.email || 'User';
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = initials; });
    document.querySelectorAll('#userName').forEach(el => { el.textContent = name; });
    document.querySelectorAll('.user-info h4').forEach(el => { el.textContent = name; });
    // Apply badge from token immediately, then refresh from live API
    _applyBadgeFromStr(user?.subscription || user?.subscriptionData?.plan || user?.role || 'FREE');
    _refreshBadgeFromAPI();
}

function _applyBadgeFromStr(raw) {
    const s = String(raw).toUpperCase();
    let cls = 'plan-free', label = 'FREE';
    if (s.includes('ELITE'))                          { cls = 'plan-elite';   label = 'ELITE'; }
    else if (s.includes('PREMIUM'))                   { cls = 'plan-premium'; label = 'PREMIUM'; }
    else if (s.includes('PRO'))                       { cls = 'plan-pro';     label = 'PRO'; }
    else if (s.includes('TRIAL') || s === 'TRIALING') { cls = 'plan-trial';   label = 'TRIAL'; }
    else if (s === 'ADMIN')                           { cls = 'plan-premium'; label = 'ADMIN'; }
    document.querySelectorAll('#planBadge').forEach(el => {
        el.className = 'plan-badge ' + cls;
        el.textContent = label;
    });
}

async function _refreshBadgeFromAPI() {
    try {
        const token = TokenManager.getAccessToken?.() || '';
        if (!token) return;
        const res = await fetch(API_CONFIG.baseURL + '/subscriptions/current', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) return;
        const data = await res.json();
        const sub = data?.subscription ?? data?.data?.subscription ?? data?.data ?? data;
        if (!sub) return;
        const status = (sub?.status || '').toUpperCase();
        if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'INACTIVE') {
            _applyBadgeFromStr('FREE');
        } else if (status === 'TRIALING') {
            _applyBadgeFromStr('TRIAL');
        } else {
            const slug = sub?.plan?.slug || sub?.planSlug || '';
            if (slug) _applyBadgeFromStr(slug);
        }
    } catch (_) { /* silent — badge stays as token value */ }
}

async function handleLogout() {
    // FIX: removed browser confirm() — each page overrides this with its own
    // branded confirmation modal (showConfirm). This fallback just logs out directly.
    LoadingManager.show('Logging out...');
    await AuthAPI.logout();
}

function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// FIX #3/#16: duration from WorkoutLog is INTEGER MINUTES — display correctly
function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '0m';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

// ── Global safety net: hide loader on any uncaught error ─────────────────────
window.addEventListener('unhandledrejection', () => {
    try { LoadingManager.hide(); } catch (_) {}
});
window.onerror = () => {
    try { LoadingManager.hide(); } catch (_) {}
};


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

    // Cross-page achievement toast — fires on any page when an achievement is earned
    window.addEventListener('storage', (e) => {
        if (e.key === 'ff_new_achievement') {
            try {
                const a = JSON.parse(e.newValue || 'null');
                if (!a || !a.name) return;
                Toast.show(
                    `🏆 Achievement unlocked: <strong>${a.name}</strong> · +${a.points || 0} pts`,
                    'success', 6000
                );
                // Clear so it doesn't re-fire on this tab's own storage events
                localStorage.removeItem('ff_new_achievement');
            } catch (_) {}
        }
    });
});



