/**
 * FlowFit API Client
 * Production-ready API integration with authentication, caching, and error handling
 */

// Configuration
const API_CONFIG = {
    baseURL: 'https://fit.cctamcc.site', // Change to production URL when deploying
    timeout: 30000,
    retryAttempts: 3,
};

// Token Management
const TokenManager = {
    getAccessToken: () => localStorage.getItem('accessToken'),
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
        const user = localStorage.getItem('user');
        return user ? JSON.parse(user) : null;
    },
    setUser: (user) => {
        localStorage.setItem('user', JSON.stringify(user));
    },
};

// Loading State Management
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
                </div>
            `;
            document.body.appendChild(loader);
        }
        loader.style.display = 'flex';
    },
    hide: () => {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    },
    message: (text) => {
        const messageEl = document.querySelector('.loader-message');
        if (messageEl) messageEl.textContent = text;
    },
};

// Toast Notifications
const Toast = {
    show: (message, type = 'info') => {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-icon">${Toast.getIcon(type)}</span>
                <span class="toast-message">${message}</span>
            </div>
        `;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('toast-show'), 100);
        setTimeout(() => {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },
    getIcon: (type) => {
        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ',
        };
        return icons[type] || icons.info;
    },
    success: (message) => Toast.show(message, 'success'),
    error: (message) => Toast.show(message, 'error'),
    warning: (message) => Toast.show(message, 'warning'),
    info: (message) => Toast.show(message, 'info'),
};

// API Request Handler
async function apiRequest(endpoint, options = {}) {
    const url = `${API_CONFIG.baseURL}${endpoint}`;
    
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    // Add auth token if available
    const token = TokenManager.getAccessToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
        ...options,
        headers,
    };

    try {
        const response = await fetch(url, config);
        
        // Handle token refresh on 401
        if (response.status === 401 && token) {
            const refreshed = await refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
                const retryResponse = await fetch(url, { ...config, headers });
                return await handleResponse(retryResponse);
            } else {
                // Refresh failed, redirect to login
                TokenManager.clearTokens();
                window.location.href = 'login.html';
                throw new Error('Session expired. Please login again.');
            }
        }

        return await handleResponse(response);
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

async function handleResponse(response) {
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || data.message || 'Request failed');
    }

    return data;
}

// Refresh access token
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
    } catch (error) {
        console.error('Token refresh failed:', error);
        return false;
    }
}

// ============================================
// AUTH API
// ============================================

const AuthAPI = {
    register: async (userData) => {
        const data = await apiRequest('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData),
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
                await apiRequest('/auth/logout', {
                    method: 'POST',
                    body: JSON.stringify({ refreshToken }),
                });
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            TokenManager.clearTokens();
            window.location.href = 'index.html';
        }
    },

    getCurrentUser: async () => {
        return await apiRequest('/auth/me');
    },

    changePassword: async (currentPassword, newPassword) => {
        return await apiRequest('/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
        });
    },
};

// ============================================
// WORKOUTS API
// ============================================

const WorkoutsAPI = {
    getExercises: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        return await apiRequest(`/workouts?${params}`);
    },

    getExerciseById: async (id) => {
        return await apiRequest(`/workouts/${id}`);
    },

    searchExercises: async (query) => {
        return await apiRequest(`/workouts/search?q=${encodeURIComponent(query)}`);
    },
};

// ============================================
// PROGRAMS API
// ============================================

const ProgramsAPI = {
    getPrograms: async (filters = {}) => {
        const params = new URLSearchParams(filters);
        return await apiRequest(`/programs?${params}`);
    },

    getProgramById: async (id) => {
        return await apiRequest(`/programs/${id}`);
    },

    enrollInProgram: async (programId) => {
        return await apiRequest(`/programs/${programId}/enroll`, {
            method: 'POST',
        });
    },

    getUserPrograms: async () => {
        return await apiRequest('/programs/my-enrollments');
    },

    updateProgress: async (enrollmentId, data) => {
        return await apiRequest(`/programs/enrollments/${enrollmentId}/progress`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    },
};

// ============================================
// PROGRESS API
// ============================================

const ProgressAPI = {
    logWorkout: async (workoutData) => {
        return await apiRequest('/progress', {
            method: 'POST',
            body: JSON.stringify(workoutData),
        });
    },

    getUserProgress: async () => {
        return await apiRequest('/progress/me');
    },

    getStats: async (period = '30d') => {
        return await apiRequest(`/progress/stats?period=${period}`);
    },

    getWorkoutHistory: async (limit = 20) => {
        return await apiRequest(`/progress/history?limit=${limit}`);
    },

    getStreaks: async () => {
        return await apiRequest('/progress/streaks');
    },

    getAchievements: async () => {
        return await apiRequest('/progress/achievements');
    },
};

// ============================================
// USER API
// ============================================

const UserAPI = {
    getProfile: async () => {
        return await apiRequest('/users/me');
    },

    updateProfile: async (profileData) => {
        return await apiRequest('/users/me', {
            method: 'PUT',
            body: JSON.stringify(profileData),
        });
    },

    updateMetrics: async (metrics) => {
        return await apiRequest('/users/metrics', {
            method: 'POST',
            body: JSON.stringify(metrics),
        });
    },

    getMetricsHistory: async () => {
        return await apiRequest('/users/metrics/history');
    },
};

// ============================================
// SUBSCRIPTION API
// ============================================

const SubscriptionAPI = {
    getCurrentSubscription: async () => {
        return await apiRequest('/subscriptions/me');
    },

    createCheckoutSession: async (plan) => {
        return await apiRequest('/subscriptions/checkout', {
            method: 'POST',
            body: JSON.stringify({ plan }),
        });
    },

    cancelSubscription: async () => {
        return await apiRequest('/subscriptions/cancel', {
            method: 'POST',
        });
    },
};

// ============================================
// UTILITIES
// ============================================

// Check if user is authenticated
function isAuthenticated() {
    return !!TokenManager.getAccessToken();
}

// Require authentication (redirect if not logged in)
function requireAuth() {
    if (!isAuthenticated()) {
        const currentPage = window.location.pathname;
        localStorage.setItem('redirectAfterLogin', currentPage);
        window.location.href = 'login.html';
        return false;
    }
    return true;
}

// Optional authentication (don't redirect)
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

// Update navigation based on auth state
function updateNavigation() {
    const user = TokenManager.getUser();
    const authButtons = document.querySelectorAll('.auth-buttons');
    
    authButtons.forEach(container => {
        if (user) {
            container.innerHTML = `
                <a href="dashboard.html" class="btn btn-ghost">Dashboard</a>
                <button onclick="handleLogout()" class="btn btn-primary">Logout</button>
            `;
        } else {
            container.innerHTML = `
                <a href="login.html" class="btn btn-ghost">Login</a>
                <a href="register.html" class="btn btn-primary">Sign Up</a>
            `;
        }
    });
}

// Handle logout
async function handleLogout() {
    if (confirm('Are you sure you want to logout?')) {
        LoadingManager.show('Logging out...');
        await AuthAPI.logout();
        LoadingManager.hide();
    }
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

// Format time duration
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Add global styles for loader and toasts
    if (!document.getElementById('global-styles')) {
        const styles = document.createElement('style');
        styles.id = 'global-styles';
        styles.textContent = `
            #global-loader {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 10000;
            }
            
            .loader-backdrop {
                position: absolute;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(5px);
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .loader-content {
                background: var(--bg-card, #1a1a24);
                padding: 2rem 3rem;
                border-radius: 20px;
                text-align: center;
            }
            
            .loader-spinner {
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255, 255, 255, 0.1);
                border-top-color: var(--accent, #f5576c);
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 1rem;
            }
            
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            
            .loader-message {
                color: var(--text-primary, #fff);
                font-size: 1rem;
            }
            
            .toast {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 1rem 1.5rem;
                border-radius: 12px;
                background: var(--bg-card, #1a1a24);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                z-index: 9999;
                transform: translateX(400px);
                transition: transform 0.3s ease;
            }
            
            .toast-show {
                transform: translateX(0);
            }
            
            .toast-content {
                display: flex;
                align-items: center;
                gap: 1rem;
                color: var(--text-primary, #fff);
            }
            
            .toast-icon {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
            }
            
            .toast-success .toast-icon {
                background: #4ade80;
                color: #000;
            }
            
            .toast-error .toast-icon {
                background: #f87171;
                color: #000;
            }
            
            .toast-warning .toast-icon {
                background: #fbbf24;
                color: #000;
            }
            
            .toast-info .toast-icon {
                background: #60a5fa;
                color: #000;
            }
        `;
        document.head.appendChild(styles);
    }
    
    // Update navigation
    updateNavigation();
});
