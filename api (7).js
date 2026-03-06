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
    show: (message, type = 'info') => {
        const existing = document.querySelectorAll('.toast');
        const offset = existing.length * 70;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.style.top = `${20 + offset}px`;
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-icon">${Toast.getIcon(type)}</span>
                <span class="toast-message">${message}</span>
            </div>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('toast-show'), 50);
        setTimeout(() => {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    },
    getIcon: (type) => ({ success: '✓', error: '✕', warning: '⚠', info: 'ℹ' }[type] || 'ℹ'),
    success: (msg) => Toast.show(msg, 'success'),
    error:   (msg) => Toast.show(msg, 'error'),
    warning: (msg) => Toast.show(msg, 'warning'),
    info:    (msg) => Toast.show(msg, 'info'),
};

async function apiRequest(endpoint, options = {}) {
    const url = `${API_CONFIG.baseURL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = TokenManager.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // ── Real timeout via AbortController ──────────────────────────────────
    // API_CONFIG.timeout was defined but never enforced — fetch would hang forever.
    // Now we race the fetch against a hard timeout (default 12s for exercises).
    const timeoutMs = options._timeout || API_CONFIG.timeout || 12000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const config = { ...options, headers, signal: controller.signal };
    // Remove our custom _timeout key so fetch doesn't see it
    delete config._timeout;

    try {
        let response = await fetch(url, config);
        clearTimeout(timeoutId);

        if (response.status === 401 && token) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
                const retryCtrl = new AbortController();
                const retryTimer = setTimeout(() => retryCtrl.abort(), timeoutMs);
                response = await fetch(url, { ...config, headers, signal: retryCtrl.signal });
                clearTimeout(retryTimer);
            } else {
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired. Please login again.');
            }
        }
        return await handleResponse(response);
    } catch (error) {
        clearTimeout(timeoutId);
        // AbortError means our timeout fired
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s. Server may be slow or unreachable.`);
        }
        if (error.name === 'TypeError') throw new Error('Network error. Check your connection.');
        throw error;
    }
}

async function handleResponse(response) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
}

async function refreshAccessToken() {
    try {
        const refreshToken = TokenManager.getRefreshToken();
        if (!refreshToken) return false;
        const response = await fetch(`${API_CONFIG.baseURL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });
        const data = await response.json();
        if (data.success && data.data) {
            TokenManager.setTokens(data.data.accessToken, data.data.refreshToken);
            return true;
        }
        return false;
    } catch { return false; }
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

// ── PROGRAMS ──────────────────────────────────────────────────────────────────
// FIX #2: Pass ALL filters — backend supports difficulty, category, isPremium, limit, page
const ProgramsAPI = {
    getPrograms: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        const res = await apiRequest(`/programs?${params}`);
        // Normalise: backend may return { programs:[...] }, { data:[...] }, or flat array
        if (res && res.success) {
            const d = res.data;
            if      (Array.isArray(d))              res.data = d;
            else if (Array.isArray(d?.programs))    res.data = d.programs;
            else if (Array.isArray(d?.data))        res.data = d.data;
            else if (Array.isArray(d?.items))       res.data = d.items;
            else res.data = [];
        }
        return res;
    },
    getProgramById: async (id) => await apiRequest(`/programs/${id}`),
    enrollInProgram: async (programId) => await apiRequest(`/programs/${programId}/enroll`, { method: 'POST' }),
    getUserPrograms: async () => {
        const res = await apiRequest('/programs/my-enrollments');
        // Normalise: backend may return { enrollments:[...] } or flat array
        if (res && res.success) {
            const d = res.data;
            if      (Array.isArray(d))              res.data = d;
            else if (Array.isArray(d?.enrollments)) res.data = d.enrollments;
            else if (Array.isArray(d?.data))        res.data = d.data;
            else res.data = [];
        }
        return res;
    },
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
        if (r && r.success) {
            const d = r.data;
            if      (Array.isArray(d))                r.data = d;
            else if (Array.isArray(d?.achievements))  r.data = d.achievements;
            else if (Array.isArray(d?.data))          r.data = d.data;
            else if (d?.unlocked || d?.locked) {
                const ul = (d.unlocked||[]).map(a => ({...a, unlocked:true}));
                const lk = (d.locked  ||[]).map(a => ({...a, unlocked:false}));
                r.data = [...ul, ...lk];
            } else r.data = [];
        }
        return r;
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
    getCurrentSubscription: async () => await apiRequest('/subscriptions/me'),

    // Stripe checkout — returns { url } to redirect to Stripe-hosted checkout
    createStripeCheckout: async (plan) => await apiRequest('/subscriptions/stripe/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: plan.toUpperCase(), successUrl: window.location.origin + '/subscription.html?success=1', cancelUrl: window.location.origin + '/subscription.html?cancel=1' }),
    }),

    // M-Pesa STK Push — initiates push to phone number
    initMpesaPayment: async (plan, phone) => await apiRequest('/subscriptions/mpesa/initiate', {
        method: 'POST',
        body: JSON.stringify({ plan: plan.toUpperCase(), phone: phone.replace(/\D/g,'') }),
    }),

    // Poll M-Pesa payment status
    checkMpesaStatus: async (checkoutRequestId) => await apiRequest(`/subscriptions/mpesa/status/${checkoutRequestId}`),

    // Legacy checkout (fallback)
    createCheckoutSession: async (plan) => await apiRequest('/subscriptions/checkout', {
        method: 'POST', body: JSON.stringify({ plan: plan.toUpperCase() }),
    }),

    cancelSubscription: async () => await apiRequest('/subscriptions/cancel', { method: 'POST' }),

    // Upgrade/downgrade
    changePlan: async (newPlan) => await apiRequest('/subscriptions/change', {
        method: 'POST', body: JSON.stringify({ plan: newPlan.toUpperCase() }),
    }),
};

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
    // Legacy selectors
    document.querySelectorAll('.user-info h4').forEach(el => { el.textContent = name; });
    // Plan badge
    const sub = user?.subscription || user?.subscriptionData?.plan || user?.role || 'FREE';
    const planStr = String(sub).toUpperCase();
    let planCls = 'plan-free', planLabel = 'FREE';
    if (planStr.includes('PREMIUM'))      { planCls = 'plan-premium'; planLabel = '⭐ PREMIUM'; }
    else if (planStr.includes('PRO'))     { planCls = 'plan-pro';     planLabel = '🥇 PRO'; }
    else if (planStr.includes('TRIAL'))   { planCls = 'plan-trial';   planLabel = '⏳ TRIAL'; }
    else if (planStr === 'ADMIN')         { planCls = 'plan-premium'; planLabel = '🛡 ADMIN'; }
    document.querySelectorAll('#planBadge').forEach(el => { el.className = 'plan-badge ' + planCls; el.textContent = planLabel; });
    document.querySelectorAll('.user-info p').forEach(el => { el.textContent = planLabel.replace(/[^a-zA-Z ]/g,'').trim(); });
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
            .toast { position:fixed; right:20px; padding:1rem 1.5rem; border-radius:12px; background:var(--bg-card,#1a1a24); border:1px solid rgba(255,255,255,0.1); box-shadow:0 10px 30px rgba(0,0,0,0.5); z-index:9999; transform:translateX(400px); transition:transform 0.3s ease; }
            .toast-show { transform:translateX(0); }
            .toast-content { display:flex; align-items:center; gap:1rem; color:var(--text-primary,#fff); }
            .toast-icon { width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; }
            .toast-success .toast-icon { background:#4ade80; color:#000; }
            .toast-error   .toast-icon { background:#f87171; color:#000; }
            .toast-warning .toast-icon { background:#fbbf24; color:#000; }
            .toast-info    .toast-icon { background:#60a5fa; color:#000; }
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
});
