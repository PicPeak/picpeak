import { toast as toastify } from 'react-toastify';
import i18n from '../i18n/config';

export const toast = {
  success: (messageKey: string, interpolations?: Record<string, any>) => {
    const message = i18n.t(messageKey, interpolations);
    toastify.success(message);
  },
  
  error: (messageKey: string, interpolations?: Record<string, any>) => {
    const message = i18n.t(messageKey, interpolations);
    toastify.error(message);
  },
  
  info: (messageKey: string, interpolations?: Record<string, any>) => {
    const message = i18n.t(messageKey, interpolations);
    toastify.info(message);
  },
  
  warning: (messageKey: string, interpolations?: Record<string, any>) => {
    const message = i18n.t(messageKey, interpolations);
    toastify.warning(message);
  },
  
  // For direct messages (not translation keys)
  successDirect: (message: string) => toastify.success(message),
  errorDirect: (message: string) => toastify.error(message),
  infoDirect: (message: string) => toastify.info(message),
  warningDirect: (message: string) => toastify.warning(message),
};