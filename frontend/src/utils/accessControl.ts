export const normalizeRequirePassword = (value: unknown, defaultValue = true): boolean => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
  }

  return defaultValue;
};

export const isGalleryPublic = (value: unknown, defaultValue = true): boolean => {
  return !normalizeRequirePassword(value, defaultValue);
};
