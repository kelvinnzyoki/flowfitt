/**
 * FlowFit API Client — Production Safe Version
 */

const API_CONFIG = {
    baseURL: 'https://fit.cctamcc.site/api/v1',
    timeout: 30000,
};

// ─────────────────────────────────────────────
// TOKEN MANAGER
// ─────────────────────────────────────────────
const TokenManager = {
    getAccessToken: () => localStorage.getItem('accessToken'),

    setTokens: (accessToken) => {
        localStorage.setItem('accessToken', accessToken);
    },

    clearTokens: () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('user');
    },

    getUser: () => {
        try {
            const u = localStorage.getItem('user');
            return u ? JSON.parse(u) : null;
        } catch {
            return null;
        }
    },

    setUser: (user) => {
        localStorage.setItem('user', JSON.stringify(user));
    },
};

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
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
                        <p class="loader-message"></p>
                    </div>
                </div>`;
            document.body.appendChild(loader);
        }

        const msg = loader.querySelector('.loader-message');
        if (msg) msg.textContent = message;

        loader.style.display = 'flex';
    },

    hide: () => {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    },
};

const Toast = {
    show: (message, type = 'info', duration = 5000) => {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const msg = document.createElement('span');
        msg.textContent = message;

        toast.appendChild(msg);
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), duration);
    },
};

// ─────────────────────────────────────────────
// CORE API REQUEST
// ─────────────────────────────────────────────
async function apiRequest(endpoint, options = {}) {
    const url = `${API_CONFIG.baseURL}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    const token = TokenManager.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        let response = await fetch(url, {
            credentials: 'include',
            ...options,
            headers
        });

        // Auto refresh token
        if (response.status === 401 && token) {
            const refreshed = await refreshAccessToken();

            if (refreshed) {
                headers.Authorization = `Bearer ${TokenManager.getAccessToken()}`;
                response = await fetch(url, { ...options, headers });
            } else {
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired');
            }
        }

        return await handleResponse(response);

    } catch (err) {
        if (err.name === 'TypeError') {
            throw new Error('Network error');
        }
        throw err;
    }
}

async function handleResponse(response) {
    const text = await response.text();

    let data = {};
    try {
        if (text) data = JSON.parse(text);
    } catch {}

    if (!response.ok) {
        throw new Error(data.message || data.error || `Error ${response.status}`);
    }

    return data;
}

async function refreshAccessToken() {
    try {
        const res = await fetch(`${API_CONFIG.baseURL}/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();

        if (data?.data?.accessToken) {
            TokenManager.setTokens(data.data.accessToken);
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────
// AUTH API
// ─────────────────────────────────────────────
const AuthAPI = {
    register: async (userData) => {
        const data = await apiRequest('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData),
        });

        if (data?.data) {
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

        if (data?.data) {
            TokenManager.setTokens(data.data.accessToken);
            TokenManager.setUser(data.data.user);
        }

        return data;
    },

    logout: async () => {
        try {
            await apiRequest('/auth/logout', { method: 'POST' });
        } finally {
            TokenManager.clearTokens();
            window.location.href = 'index.html';
        }
    },

    getCurrentUser: () => apiRequest('/auth/me'),
};

// ─────────────────────────────────────────────
// WORKOUTS API
// ─────────────────────────────────────────────
const WorkoutsAPI = {
    getExercises: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        const res = await apiRequest(`/workouts?${params}`);

        if (res?.success) {
            const d = res.data;

            if (Array.isArray(d)) return d;
            if (Array.isArray(d?.workouts)) return d.workouts;
            if (Array.isArray(d?.data)) return d.data;

            return [];
        }

        return [];
    },

    getExerciseById: (id) => apiRequest(`/workouts/${id}`),
};

// ─────────────────────────────────────────────
// PROGRAMS API
// ─────────────────────────────────────────────
const ProgramsAPI = {
    getPrograms: (filters = {}) => {
        const params = new URLSearchParams(filters);
        return apiRequest(`/programs?${params}`);
    },

    enroll: (id) =>
        apiRequest(`/programs/${id}/enroll`, { method: 'POST' }),
};

// ─────────────────────────────────────────────
// PROGRESS API
// ─────────────────────────────────────────────
const ProgressAPI = {
    logWorkout: (data) =>
        apiRequest('/progress', {
            method: 'POST',
            body: JSON.stringify({
                ...data,
                duration: parseInt(data.duration),
            }),
        }),

    getStats: () => apiRequest('/progress/stats'),
};

// ─────────────────────────────────────────────
// USER API
// ─────────────────────────────────────────────
const UserAPI = {
    getProfile: () => apiRequest('/users/me'),

    updateProfile: (data) =>
        apiRequest('/users/me', {
            method: 'PUT',
            body: JSON.stringify(data),
        }),
};

// ─────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────
function isAuthenticated() {
    return !!TokenManager.getAccessToken();
}

function requireAuth() {
    if (!isAuthenticated()) {
        window.location.href = 'login.html';
        return false;
    }
    return true;
}

async function checkAuth() {
    try {
        if (!isAuthenticated()) return null;

        const res = await AuthAPI.getCurrentUser();
        if (res?.data) {
            TokenManager.setUser(res.data);
            return res.data;
        }
    } catch {
        TokenManager.clearTokens();
    }

    return null;
}

// ─────────────────────────────────────────────
// SIDEBAR USER
// ─────────────────────────────────────────────
const SidebarUser = {
    populate() {
        const user = TokenManager.getUser();
        if (!user) return;

        const name = user.name || user.email || 'User';
        const initials = name
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);

        document.querySelectorAll('.user-avatar')
            .forEach(el => el.textContent = initials);

        document.querySelectorAll('#userName')
            .forEach(el => el.textContent = name);
    }
};

// Backward compatibility
function populateSidebarUser() {
    SidebarUser.populate();
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function formatDuration(minutes) {
    if (!minutes) return '0m';

    const h = Math.floor(minutes / 60);
    const m = minutes % 60;

    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
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
