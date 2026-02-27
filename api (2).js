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
    const config = { ...options, headers };
    try {
        let response = await fetch(url, config);
        if (response.status === 401 && token) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
                response = await fetch(url, { ...config, headers });
            } else {
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired. Please login again.');
            }
        }
        return await handleResponse(response);
    } catch (error) {
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
        return await apiRequest(`/workouts?${params}`);
    },
    searchExercises: async (query) => await apiRequest(`/workouts/search?q=${encodeURIComponent(query)}`),
    getExerciseById: async (id) => await apiRequest(`/workouts/${id}`),
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
    getAchievements:   async ()              => await apiRequest('/progress/achievements'),
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
    getCurrentSubscription: async ()     => await apiRequest('/subscriptions/me'),
    createCheckoutSession:  async (plan) => await apiRequest('/subscriptions/checkout', {
        method:'POST', body:JSON.stringify({ plan: plan.toUpperCase() }),
    }),
    cancelSubscription: async () => await apiRequest('/subscriptions/cancel', { method:'POST' }),
};

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
    const plan = (user.role === 'ADMIN') ? 'Admin' : 'Member';
    document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = initials; });
    document.querySelectorAll('.user-info h4').forEach(el => { el.textContent = name; });
    document.querySelectorAll('.user-info p').forEach(el => { el.textContent = plan; });
}

async function handleLogout() {
    if (confirm('Are you sure you want to logout?')) {
        LoadingManager.show('Logging out...');
        await AuthAPI.logout();
    }
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
            .loader-content { background:var(--bg-card,#1a1a24); padding:2rem 3rem; border-radius:20px; text-align:center; }
            .loader-spinner { width:50px; height:50px; border:4px solid rgba(255,255,255,0.1); border-top-color:var(--accent,#f5576c); border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 1rem; }
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
            .btn-log-submit { background:linear-gradient(135deg,#fa709a 0%,#fee140 100%); color:#000; }
            .btn-log-cancel { background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.08) !important; }
        `;
        document.head.appendChild(styles);
    }
    updateNavigation();
    populateSidebarUser();
});
