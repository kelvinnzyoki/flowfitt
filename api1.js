/**
 * FlowFit API Client — Fixed version
 * Bugs fixed: #1 workout filters, #2 program filters, #3 formatDuration (minutes not seconds)
 */

const API_CONFIG = {
    baseURL: 'https://fit.cctamcc.site/api/v1',
    timeout: 30000,
};

const TokenManager = {
    // Access token lives in memory only — never in localStorage.
    // In-memory storage is invisible to other tabs and third-party scripts,
    // eliminating the XSS surface of localStorage for sensitive tokens.
    // The token is lost on page reload, but silently restored via the
    // ff_refresh httpOnly cookie (see requireAuth / refreshAccessToken).
    _accessToken: null,

    getAccessToken() { return this._accessToken; },

    // Called after login/register/refresh — stores the access token in memory.
    // The server has already set ff_refresh and ff_access as httpOnly cookies
    // and ff_session as a JS-readable session indicator in the response.
    setTokens(accessToken) {
        this._accessToken = accessToken || null;
    },
clearTokens() {
    this._accessToken = null;
    localStorage.removeItem('user');
    // Clear ALL session caches — stale plan/subscription data from a previous
    // user session must not leak to the next user on the same browser.
    try { sessionStorage.clear(); } catch {}
},


    // Read the non-httpOnly ff_session=1 cookie the server sets alongside the
    // httpOnly tokens. Presence means a valid refresh token likely exists.
    // This lets us attempt a silent refresh on page load without exposing secrets.
    hasSession() {
        try {
            return document.cookie.split(';').some(c => c.trim().startsWith('ff_session='));
        } catch { return false; }
    },

    getUser() {
        try {
            const u = localStorage.getItem('user');
            return u ? JSON.parse(u) : null;
        } catch { return null; }
    },
    setUser(user) {
        try { localStorage.setItem('user', JSON.stringify(user)); } catch {}
    },
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
        // Restack existing toasts so new one doesn't overlap
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
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // credentials:'include' sends the httpOnly refreshToken cookie on every request
    // Required for cross-origin requests (GitHub Pages → Vercel backend)

    const config = { credentials: 'include', cache: 'no-store', ...options, headers };
    
    
    try {
        let response = await fetch(url, config);
        // Handle 401: if the access token has expired, attempt a silent refresh
        // then retry the original request once. Any other 401 falls through to
        // handleResponse which throws the server's error message.
        if (response.status === 401) {
            let body = {};
            // Clone before reading so the original stream stays intact for handleResponse
            try { body = await response.clone().json(); } catch { /* non-JSON 401 body */ }

            if (body.code === 'TOKEN_EXPIRED') {
                // refreshAccessToken() POSTs to the correct full URL with credentials
                const refreshed = await refreshAccessToken();
                if (refreshed) {
                    // Rebuild headers with the new access token and retry once
                    const newToken = TokenManager.getAccessToken();
                    const retryHeaders = { ...headers };
                    if (newToken) retryHeaders['Authorization'] = `Bearer ${newToken}`;
                    response = await fetch(url, { ...config, headers: retryHeaders });
                    return await handleResponse(response);
                }
                // Refresh also failed — session is dead, force re-login
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired. Please log in again.');
            }
            // Other 401 (wrong credentials, account locked, etc.) — let handleResponse
            // extract and throw the server's error message as usual
        }

        return await handleResponse(response);
    } catch (error) {
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

// FIX 1: Deduplication gate — if a refresh is already in-flight, every concurrent
// caller awaits the SAME Promise rather than each firing its own POST.
//
// Without this, Promise.all([loadStreak(), loadStats(), ...]) on dashboard load would
// send N independent refresh requests when the access token expires. Only the first
// can succeed (old token is rotated out of the DB immediately). Calls 2…N find the
// old token gone → server returns 401 "Session expired" → refreshed=false →
// clearTokens() → redirect to login.html. User is logged out every 15 minutes.
let _refreshInFlight = null;

let _authReady = null;
let _authReadyResolve = null;
function _getAuthReadyPromise() {
    if (!_authReady) {
        _authReady = new Promise(resolve => { _authReadyResolve = resolve; });
    }
    return _authReady;
}
function _signalAuthReady(success) {
    _getAuthReadyPromise();
    if (_authReadyResolve) { _authReadyResolve(success); _authReadyResolve = null; }
}

async function refreshAccessToken() {
    if (_refreshInFlight) return _refreshInFlight;

    _refreshInFlight = (async () => {
        try {
            const response = await fetch(`${API_CONFIG.baseURL}/auth/refresh`, {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
            });

            

            if (!response.ok) return false;

            const data = await response.json();

            if (data.success && typeof data.data?.accessToken === 'string' && data.data.accessToken) {
                TokenManager.setTokens(data.data.accessToken);
                return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            _refreshInFlight = null;
        }
    })();

    return _refreshInFlight;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
const AuthAPI = {
    checkSession: async () => {
        try {
            const res = await fetch(`${API_CONFIG.baseURL}/auth/session`, {
                method: 'GET',
                credentials: 'include',
            });
            if (!res.ok) return false;
            const data = await res.json();
            return data?.valid === true;
        } catch {
            return false;
        }
    },
    register: async (userData) => {
        const { name, email, password } = userData;
        const data = await apiRequest('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, password }),
        });
        if (data.success && data.data) {
            // refreshToken set as httpOnly cookie by server — only store accessToken
            TokenManager.setTokens(data.data.accessToken);
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
        TokenManager.setTokens(data.data.accessToken);
        // Fetch canonical user from /me — not the login payload — so
        // the stored object is always complete and up-to-date.
        try {
            const me = await AuthAPI.getCurrentUser();
            if (me?.success && me?.data) TokenManager.setUser(me.data);
            else TokenManager.setUser(data.data.user);
        } catch { TokenManager.setUser(data.data.user); }
    }
    return data;
},
    logout: async () => {
    // Clear client state immediately — do NOT wait for server.
    // This prevents any window where stale cookies/state could
    // be picked up by the next user on the same browser.
    TokenManager.clearTokens();
    try {
        await apiRequest('/auth/logout', { method: 'POST' });
    } catch (e) { console.error('Logout error:', e); }
    window.location.href = 'index.html';
},
    getCurrentUser: async () => await apiRequest('/auth/me'),
    changePassword: async (currentPassword, newPassword) => await apiRequest('/auth/change-password', {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),
};


// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
const NotificationsAPI = {
    // FIX: Both getAll and getUnreadCount previously used raw fetch with:
    //   'Authorization': 'Bearer ' + (getAccessToken() || '')
    // When getAccessToken() returns null (token not yet loaded or cleared),
    // this sent the literal string "Bearer " (empty token).
    // jwt.verify('', secret) throws JsonWebTokenError → authenticate returns
    // 401 { error: 'Invalid token.' } — not TOKEN_EXPIRED, so the client
    // never attempted a refresh. This also bypassed apiRequest's
    // TOKEN_EXPIRED → refresh → retry logic entirely.
    //
    // Fix: route both through apiRequest, which:
    //   1. Only sets Authorization when token is a non-empty string
    //   2. Handles TOKEN_EXPIRED by calling refreshAccessToken() + retrying
    //   3. Handles the _refreshInFlight deduplication gate

    getAll: async (limit = 30) =>
        apiRequest(`/notifications?limit=${limit}`)
            .then(data => data ?? { notifications: [], unreadCount: 0 })
            .catch(() => ({ notifications: [], unreadCount: 0 })),

    getUnreadCount: async () =>
        apiRequest('/notifications/unread')
            .then(data => data ?? { count: 0 })
            .catch(() => ({ count: 0 })),

    markRead:    async (id) => apiRequest(`/notifications/${id}/read`,  { method: 'PUT' }),
    markAllRead: async ()   => apiRequest('/notifications/read-all',    { method: 'PUT' }),
    delete:      async (id) => apiRequest(`/notifications/${id}`,       { method: 'DELETE' }),
};

// ── WORKOUTS ──────────────────────────────────────────────────────────────────
// FIX #1: Pass ALL filters — backend supports category, difficulty, muscle, equipment, limit, page
// Resolved at runtime — set to '/workouts' or '/exercises' depending on which the
// server responds to. Cached after the first successful call so we only probe once.
let _workoutsBasePath = null;

async function _resolveWorkoutsPath() {
    if (_workoutsBasePath) return _workoutsBasePath;
    // Try /workouts first (workout_routes.ts mounted there via routes/index.js)
    try {
        const probe = await fetch(
            `${API_CONFIG.baseURL}/workouts?limit=1`,
            {
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...(TokenManager.getAccessToken()
                        ? { Authorization: `Bearer ${TokenManager.getAccessToken()}` }
                        : {}),
                },
            }
        );
        // 200 or 401 both mean the route EXISTS (401 = auth failed, not 404)
        if (probe.status !== 404) {
            _workoutsBasePath = '/workouts';
            return _workoutsBasePath;
        }
    } catch {}
    // Fallback: /exercises (exercise.routes.ts mounted at /api/v1/exercises in routes/index)
    _workoutsBasePath = '/exercises';
    return _workoutsBasePath;
}

const WorkoutsAPI = {
    getExercises: async (filters = {}) => {
        const base = await _resolveWorkoutsPath();
        // Strip undefined/null/empty values so the server never receives garbage params
        const clean = Object.fromEntries(
            Object.entries(filters)
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([k, v]) => [k, String(v)])
        );
        const params = new URLSearchParams(clean);
        const res = await apiRequest(`${base}?${params}`);
        if (res && res.success && !Array.isArray(res.data)) res.data = [];
        return res;
    },
    searchExercises: async (query) => {
        const base = await _resolveWorkoutsPath();
        const r = await apiRequest(`${base}/search?q=${encodeURIComponent(query)}`);
        if (r && r.success && !Array.isArray(r.data)) r.data = [];
        return r;
    },
    getExerciseById: async (id) => {
        const base = await _resolveWorkoutsPath();
        return await apiRequest(`${base}/${id}`);
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
    // Cancel (delete) an enrollment so the user can re-enroll from scratch
    cancelEnrollment: async (enrollmentId) => await apiRequest(`/programs/enrollments/${enrollmentId}`, {
        method: 'DELETE',
    }),
};

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
    recalculateAchievements: async () => await apiRequest('/progress/achievements/recalculate', { method: 'POST' }),
};

// ── USERS ─────────────────────────────────────────────────────────────────────
const UserAPI = {
    getProfile:        async ()             => await apiRequest('/users/me'),
    updateProfile:     async (profileData)  => await apiRequest('/users/me', { method:'PUT', body:JSON.stringify(profileData) }),
    updateMetrics:     async (metrics)      => await apiRequest('/users/metrics', { method:'POST', body:JSON.stringify(metrics) }),
    getMetricsHistory: async (limit=30)     => await apiRequest(`/users/metrics/history?limit=${limit}`),

    /**
     * Compute biometric analytics from real DB data.
     *
     * Data sources (all from existing routes):
     *   GET /users/me            → profile.weight, profile.height, profile.dateOfBirth, profile.gender
     *   GET /users/metrics/history → ordered metric snapshots (weight trend)
     *   GET /progress/stats?period=30d → totalWorkouts (activity consistency)
     *   GET /progress/stats?period=90d → 90-day history for strength progress estimate
     *   GET /progress/streaks    → currentStreak (consistency bonus)
     *
     * Formulas:
     *   BMI             = weight(kg) / (height(m))²
     *   Body Fat % (M)  = 1.20×BMI + 0.23×Age − 16.2
     *   Body Fat % (F)  = 1.20×BMI + 0.23×Age −  5.4
     *   Fitness Score   = clamp(bmiScore + bfScore + activityScore + strengthScore, 0, 100)
     *     bmiScore      = 25 × (1 − |BMI−22| / 20)          (peaks at BMI 22, ideal midpoint)
     *     bfScore       = 25 × (1 − clamp(bf−ideal, 0, 20) / 20)
     *     activityScore = 25 × clamp(workouts30d / 20, 0, 1) (20 workouts/month = perfect)
     *     strengthScore = 25 × clamp(workouts90d / 60, 0, 1) (60 workouts/90d = perfect)
     *
     * Returns: { success, data: { bmi, bmiCategory, bodyFatPct, weightTrend,
     *                             fitnesScore, bmiScore, activityScore, strengthScore,
     *                             bfScore, profile, metricsHistory } }
     */
    getBiometricAnalytics: async () => {
        try {
            const [profileRes, metricsRes, stats30Res, stats90Res, streakRes] = await Promise.all([
                apiRequest('/users/me').catch(() => null),
                apiRequest('/users/metrics/history?limit=10').catch(() => null),
                apiRequest('/progress/stats?period=30d').catch(() => null),
                apiRequest('/progress/stats?period=90d').catch(() => null),
                apiRequest('/progress/streaks').catch(() => null),
            ]);

            const profile = profileRes?.data?.profile || profileRes?.data || null;
            const user    = profileRes?.data || null;

            // ── Raw biometric inputs ───────────────────────────────────
            const weightKg  = parseFloat(profile?.weight)  || null;
            const heightCm  = parseFloat(profile?.height)  || null;
            const gender    = (profile?.gender || '').toUpperCase(); // 'MALE' | 'FEMALE'
            const dob       = profile?.dateOfBirth ? new Date(profile.dateOfBirth) : null;
            const ageYears  = dob
                ? Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000))
                : null;

            // ── BMI ───────────────────────────────────────────────────
            let bmi = null;
            if (weightKg && heightCm && heightCm > 0) {
                const heightM = heightCm / 100;
                bmi = +(weightKg / (heightM * heightM)).toFixed(1);
            }

            // ── BMI Category ─────────────────────────────────────────
            let bmiCategory = null;
            if (bmi !== null) {
                if      (bmi < 18.5) bmiCategory = 'Underweight';
                else if (bmi < 25.0) bmiCategory = 'Normal';
                else if (bmi < 30.0) bmiCategory = 'Overweight';
                else                 bmiCategory = 'Obese';
            }

            // ── Body Fat % (Deurenberg formula) ──────────────────────
            let bodyFatPct = null;
            if (bmi !== null && ageYears !== null) {
                const genderConst = gender === 'FEMALE' ? -5.4 : -16.2;
                bodyFatPct = +(1.20 * bmi + 0.23 * ageYears + genderConst).toFixed(1);
                bodyFatPct = Math.max(3, bodyFatPct); // physiological floor
            }

            // ── Weight Change Trend (last 2 metrics snapshots) ───────
            const metricsHistory = Array.isArray(metricsRes?.data) ? metricsRes.data : [];
            let weightTrend = null; // kg, positive = gained, negative = lost
            let weightTrendPct = null;
            if (metricsHistory.length >= 2) {
                const latest = parseFloat(metricsHistory[0]?.weight);
                const prev   = parseFloat(metricsHistory[metricsHistory.length - 1]?.weight);
                if (!isNaN(latest) && !isNaN(prev) && prev > 0) {
                    weightTrend    = +(latest - prev).toFixed(1);
                    weightTrendPct = +(((latest - prev) / prev) * 100).toFixed(1);
                }
            } else if (metricsHistory.length === 1 && weightKg) {
                // Only one snapshot — compare to profile weight
                const snap = parseFloat(metricsHistory[0]?.weight);
                if (!isNaN(snap) && weightKg > 0) {
                    weightTrend    = +(snap - weightKg).toFixed(1);
                    weightTrendPct = +(((snap - weightKg) / weightKg) * 100).toFixed(1);
                }
            }

            // ── Activity inputs for fitness score ─────────────────────
            const stats30 = stats30Res?.data?.stats || stats30Res?.data || {};
            const stats90 = stats90Res?.data?.stats || stats90Res?.data || {};
            const workouts30d = stats30.totalWorkouts || 0;
            const workouts90d = stats90.totalWorkouts || 0;
            const streak      = streakRes?.data?.currentStreak || 0;

            // ── Fitness Score sub-components (each 0–25, total 0–100) ─
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

            // BMI score: peaks at 22 (ideal), ±20 span to zero
            const bmiScore = bmi !== null
                ? +(25 * clamp(1 - Math.abs(bmi - 22) / 20, 0, 1)).toFixed(1)
                : 0;

            // Body fat score: gender-specific ideal ranges
            const idealBf = gender === 'FEMALE' ? 22 : 15; // midpoint of fit range
            const bfScore = bodyFatPct !== null
                ? +(25 * clamp(1 - Math.abs(bodyFatPct - idealBf) / 25, 0, 1)).toFixed(1)
                : 0;

            // Activity consistency: 20 workouts/month = perfect
            // Streak bonus: each 7-day streak adds 1 extra point (capped at 5)
            const streakBonus   = clamp(Math.floor(streak / 7), 0, 5);
            const activityScore = +(clamp(25 * clamp(workouts30d / 20, 0, 1) + streakBonus, 0, 25)).toFixed(1);

            // Strength progress: 60 workouts/90 days = sustained training
            const strengthScore = +(25 * clamp(workouts90d / 60, 0, 1)).toFixed(1);

            const fitnessScore = +(bmiScore + bfScore + activityScore + strengthScore).toFixed(0);

            return {
                success: true,
                data: {
                    bmi, bmiCategory, bodyFatPct,
                    weightTrend, weightTrendPct,
                    fitnessScore,
                    breakdown: { bmiScore, bfScore, activityScore, strengthScore },
                    inputs: { weightKg, heightCm, ageYears, gender, workouts30d, workouts90d, streak },
                    metricsHistory,
                    profile,
                },
            };
        } catch (err) {
            console.error('[UserAPI.getBiometricAnalytics]', err);
            return { success: false, error: err?.message || 'Failed to compute analytics' };
        }
    },
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
    // Paystack: returns { authorizationUrl, reference, accessCode }
    // Frontend should redirect user to authorizationUrl; after payment Paystack
    // redirects to callbackUrl. Frontend then calls verifyPayment(reference).
    createCheckoutSession: async (planId, interval = 'MONTHLY', callbackUrl) => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST',
            body: JSON.stringify({ planId, interval, ...(callbackUrl ? { callbackUrl } : {}) }),
        });
        if (res && res.authorizationUrl) return { success: true, data: { authorizationUrl: res.authorizationUrl, reference: res.reference, accessCode: res.accessCode } };
        if (res && res.success) return res;
        return res;
    },

    // Paystack checkout — preferred alias for pages calling the Paystack flow
    createPaystackCheckout: async (planId, interval = 'MONTHLY', callbackUrl) => {
        const res = await apiRequest('/subscriptions/checkout', {
            method: 'POST',
            body: JSON.stringify({ planId, interval, ...(callbackUrl ? { callbackUrl } : {}) }),
        });
        if (res && res.authorizationUrl) return { success: true, data: { authorizationUrl: res.authorizationUrl, reference: res.reference, accessCode: res.accessCode } };
        if (res && res.success) return res;
        return res;
    },

    // Deprecated alias — kept so any page still calling createStripeCheckout keeps working
    createStripeCheckout: async (planId, interval = 'MONTHLY', callbackUrl) => {
        return SubscriptionAPI.createPaystackCheckout(planId, interval, callbackUrl);
    },

    // GET /subscriptions/paystack/verify/:reference
    // Call this after Paystack redirects back to your callbackUrl.
    // Verifies the transaction server-side and activates the subscription.
    // Returns { success, status, subscription? }
    verifyPayment: async (reference) => {
        const res = await apiRequest(`/subscriptions/paystack/verify/${encodeURIComponent(reference)}`);
        if (res && res.success !== undefined) return res;
        return { success: false, message: 'Verification failed' };
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
// True when we have an in-memory access token OR the server's session
// indicator cookie is present (meaning a silent refresh should succeed).
function isAuthenticated() {
    return !!TokenManager.getAccessToken() || TokenManager.hasSession();
}

// Async guard — call at the top of every protected page's DOMContentLoaded.
// Fast path: access token already in memory → return true immediately.
// Reload path: no memory token but ff_session cookie present → attempt one
//   silent refresh before deciding whether to redirect.
// No session at all → redirect to login.html.
//
// Usage (on every protected page):
//   document.addEventListener('DOMContentLoaded', async () => {
//     if (!await requireAuth()) return;
//     // ... rest of page init
//   });
async function requireAuth() {
    if (TokenManager.getAccessToken()) {
        _signalAuthReady(true);
        return true;
    }
    const refreshed = await refreshAccessToken();
    _signalAuthReady(refreshed);
    if (refreshed) {
        // CRITICAL: fetch fresh user data after token refresh so
        // TokenManager.getUser() never returns a previous user's object.
        try {
            const me = await AuthAPI.getCurrentUser();
            if (me?.success && me?.data) TokenManager.setUser(me.data);
        } catch { /* non-blocking */ }
        return true;
    }
    try { localStorage.setItem('redirectAfterLogin', window.location.pathname); } catch {}
    window.location.href = 'login.html';
    return false;
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

// SidebarUser — manages sidebar name, avatar initials, and plan badge
const SidebarUser = {
    // Call on every dashboard page load to populate name + badge
    populate() {
        const user = TokenManager.getUser();
        if (!user) return;
        const name = user.name || user.email || 'User';
        const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = initials; });
        document.querySelectorAll('#userName').forEach(el => { el.textContent = name; });
        document.querySelectorAll('.user-info h4').forEach(el => { el.textContent = name; });
        // Show badge from stored token immediately (no flicker), then refresh from live API
        SidebarUser._applyBadgeFromStr(
            user?.subscription || user?.subscriptionData?.plan || user?.role || 'FREE'
        );
        SidebarUser._refreshBadgeFromAPI();
    },

    // Apply badge classes/label from a raw plan string (slug, status, or role)
    _applyBadgeFromStr(raw) {
        const s = String(raw).toUpperCase();
        let cls = 'plan-free', label = 'FREE';
        if (s.includes('ELITE'))                        { cls = 'plan-elite';   label = 'ELITE'; }
        else if (s.includes('PREMIUM'))                 { cls = 'plan-premium'; label = 'PREMIUM'; }
        else if (s.includes('PRO'))                     { cls = 'plan-pro';     label = 'PRO'; }
        else if (s.includes('TRIAL') || s === 'TRIALING') { cls = 'plan-trial'; label = 'TRIAL'; }
        else if (s === 'ADMIN')                         { cls = 'plan-premium'; label = 'ADMIN'; }
        document.querySelectorAll('#planBadge').forEach(el => {
            el.className = 'plan-badge ' + cls;
            el.textContent = label;
        });
    },

    // Fetch live plan from API — keeps badge in sync after subscription changes
    async _refreshBadgeFromAPI() {
        try {
            const token = TokenManager.getAccessToken?.() || '';
            if (!token) return;
            const res = await fetch(API_CONFIG.baseURL + '/subscriptions/current', {
                credentials: 'include',
                headers: { 'Authorization': 'Bearer ' + token },
            });
            if (!res.ok) return;
            const data = await res.json();
            const sub = data?.subscription ?? data?.data?.subscription ?? data?.data ?? data;
            if (!sub) return;
            const status = (sub?.status || '').toUpperCase();
            if (['CANCELLED','EXPIRED','INACTIVE','INCOMPLETE_EXPIRED'].includes(status)) {
                SidebarUser._applyBadgeFromStr('FREE');
            } else if (status === 'TRIALING') {
                SidebarUser._applyBadgeFromStr('TRIAL');
            } else {
                const slug = sub?.plan?.slug || sub?.planSlug || '';
                if (slug) SidebarUser._applyBadgeFromStr(slug);
            }
        } catch (_) { /* silent — badge stays as stored value */ }
    },
};

// Convenience wrapper — kept for backward compat with pages that call populateSidebarUser()
function populateSidebarUser() { SidebarUser.populate(); }

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
});

// Add near the other globals, after _getAuthReadyPromise is defined
window.waitForAuth = () => _getAuthReadyPromise();
