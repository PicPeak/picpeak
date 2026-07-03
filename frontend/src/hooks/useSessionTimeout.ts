import { useEffect, useCallback } from 'react';
import { api } from '../config/api';

// Hook to handle session timeout
export const useSessionTimeout = () => {
  const handleSessionTimeout = useCallback((error: any) => {
    if (error?.response?.data?.code === 'SESSION_TIMEOUT') {
      // Defense-in-depth for the redirect-loop bug class (issue #350):
      // the previous implementation called the AdminAuthContext logout()
      // (which dispatches POST /auth/logout fire-and-forget AND has its
      // own finally-block redirect) and then set window.location.href
      // immediately. The cookie wasn't reliably cleared before the page
      // reloaded — if the next /auth/session call read the stale cookie
      // AND any server asymmetry returned valid:true for it, the redirect
      // loop replayed inside the same tab. Two-tab/multi-refresh "fixes"
      // were just the logout request eventually completing in time.
      //
      // We now (a) await the server-side logout so the cookie is
      // guaranteed cleared before the new page loads, (b) clear
      // sessionStorage directly so we don't depend on AdminAuthContext's
      // logout (which has the side-effect redirect we don't want), and
      // (c) navigate exactly once with the ?session=expired query the
      // login page reads to show the "your session expired" toast.
      void (async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          // Ignore; the cookie may already be invalid server-side. The
          // redirect below still happens and the next /auth/session call
          // will return 401 (no token) either way.
        }
        try {
          sessionStorage.removeItem('admin_user');
        } catch {
          // sessionStorage can throw in private-browsing modes — ignore.
        }
        window.location.href = '/admin/login?session=expired';
      })();
      return true;
    }
    return false;
  }, []);
  
  useEffect(() => {
    // Add response interceptor to handle session timeout
    const interceptor = api.interceptors.response.use(
      response => response,
      error => {
        if (handleSessionTimeout(error)) {
          // Don't propagate the error if it was a session timeout
          return Promise.reject(new Error('Session expired'));
        }
        return Promise.reject(error);
      }
    );
    
    // Clean up interceptor on unmount
    return () => {
      api.interceptors.response.eject(interceptor);
    };
  }, [handleSessionTimeout]);
  
  return { handleSessionTimeout };
};