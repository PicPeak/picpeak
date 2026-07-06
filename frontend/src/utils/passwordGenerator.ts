/**
 * Password generator utility for event creation
 * Generates secure, memorable passwords based on hostname/venue and event date
 */

interface PasswordConfig {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecialChars: boolean;
  complexity: 'simple' | 'moderate' | 'strong' | 'very_strong';
}

interface GeneratePasswordOptions {
  eventName?: string;
  eventDate?: string;
  eventType?: string;
  config?: Partial<PasswordConfig>;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const SPECIAL_CHARS = ['!', '@', '#', '$', '%', '&', '*'];

/**
 * Get default password configuration based on complexity level
 */
function getDefaultConfig(complexity: string = 'moderate'): PasswordConfig {
  const configs: Record<string, PasswordConfig> = {
    simple: {
      minLength: 6,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSpecialChars: false,
      complexity: 'simple'
    },
    moderate: {
      minLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecialChars: false,
      complexity: 'moderate'
    },
    strong: {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecialChars: false,
      complexity: 'strong'
    },
    very_strong: {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecialChars: true,
      complexity: 'very_strong'
    }
  };

  return configs[complexity] || configs.moderate;
}

/**
 * Clean and format venue name for password generation
 */
function formatVenueName(eventName: string): string {
  if (!eventName) return 'Event';
  
  // Extract venue/location from event name
  // Common patterns: "Wedding at Venue Name", "Birthday - Venue", "Corporate Event Venue"
  let venue = eventName;
  
  // Remove event type prefixes
  venue = venue
    .replace(/^(wedding|birthday|corporate|event)\s*(at|[-\s])\s*/i, '')
    .trim();
  
  // If no venue extracted, use first meaningful word
  if (!venue || venue === eventName) {
    const words = eventName
      .split(/[\s\-_]+/)
      .filter(word => word.length > 2)
      .filter(word => !['and', 'the', 'of', 'at', 'in', 'on'].includes(word.toLowerCase()));
    
    venue = words[0] || 'Event';
  }
  
  // Clean up venue name - keep only letters and numbers, capitalize first letter
  venue = venue
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 12); // Limit length
  
  if (venue.length === 0) venue = 'Event';
  
  // Capitalize first letter
  venue = venue.charAt(0).toUpperCase() + venue.slice(1).toLowerCase();
  
  return venue;
}

/**
 * Format date for password generation
 */
function formatDate(dateString: string): { year: string; month: string; day: string } {
  if (!dateString) {
    const now = new Date();
    return {
      year: now.getFullYear().toString(),
      month: MONTHS[now.getMonth()],
      day: now.getDate().toString().padStart(2, '0')
    };
  }

  const date = new Date(dateString);
  return {
    year: date.getFullYear().toString(),
    month: MONTHS[date.getMonth()],
    day: date.getDate().toString().padStart(2, '0')
  };
}

/**
 * Generate password based on venue and date with security requirements
 */
export function generateEventPassword(options: GeneratePasswordOptions = {}): string {
  const { eventName = '', eventDate = '', config: userConfig = {} } = options;
  
  // Get configuration
  const config = { ...getDefaultConfig(), ...userConfig };
  
  // Get venue name and date components
  const venue = formatVenueName(eventName);
  const { year, month, day } = formatDate(eventDate);
  
  let password = '';
  
  // Build password based on complexity level
  switch (config.complexity) {
    case 'simple':
      // Simple: VenueYear (e.g., "Venue2024")
      password = `${venue}${year}`;
      break;
      
    case 'moderate':
      // Moderate: VenueYear$Month (e.g., "Venue2024$August")
      password = `${venue}${year}${config.requireSpecialChars ? '$' : ''}${month}`;
      break;
      
    case 'strong':
      // Strong: VenueYearMonthDay! (e.g., "Venue2024August15!")
      password = `${venue}${year}${month}${day}${config.requireSpecialChars ? '!' : ''}`;
      break;
      
    case 'very_strong':
      // Very Strong: VenueYear$Month&Day! (e.g., "Venue2024$August&15!")
      const specialChar1 = SPECIAL_CHARS[Math.floor(Math.random() * SPECIAL_CHARS.length)];
      const specialChar2 = SPECIAL_CHARS[Math.floor(Math.random() * SPECIAL_CHARS.length)];
      password = `${venue}${year}${specialChar1}${month}${specialChar2}${day}!`;
      break;
      
    default:
      password = `${venue}${year}${month}`;
  }
  
  // Ensure password meets minimum length requirement
  if (password.length < config.minLength) {
    const suffix = Math.random().toString(36).substring(2, config.minLength - password.length + 2);
    password += suffix;
  }
  
  // Ensure password meets character requirements
  password = ensurePasswordRequirements(password, config);
  
  return password;
}

/**
 * Ensure password meets all security requirements
 */
function ensurePasswordRequirements(password: string, config: PasswordConfig): string {
  let result = password;
  
  // Ensure uppercase if required
  if (config.requireUppercase && !/[A-Z]/.test(result)) {
    // Capitalize first letter if not already
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  
  // Ensure lowercase if required
  if (config.requireLowercase && !/[a-z]/.test(result)) {
    // Make sure we have at least one lowercase
    if (result.length > 1) {
      result = result.charAt(0) + result.charAt(1).toLowerCase() + result.slice(2);
    }
  }
  
  // Ensure numbers if required
  if (config.requireNumbers && !/[0-9]/.test(result)) {
    result += '1';
  }
  
  // Ensure special characters if required
  if (config.requireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>?]/.test(result)) {
    result += '$';
  }
  
  return result;
}

/**
 * Generate multiple password suggestions
 */
export function generatePasswordSuggestions(options: GeneratePasswordOptions = {}): string[] {
  const suggestions: string[] = [];
  
  // Generate passwords with different complexity levels
  const complexities: Array<'simple' | 'moderate' | 'strong' | 'very_strong'> = 
    ['simple', 'moderate', 'strong', 'very_strong'];
  
  complexities.forEach(complexity => {
    const config = getDefaultConfig(complexity);
    suggestions.push(generateEventPassword({ ...options, config }));
  });
  
  // Generate alternative formats
  if (options.eventDate) {
    const { year, day } = formatDate(options.eventDate);
    const venue = formatVenueName(options.eventName || '');
    
    // Add date format variations
    suggestions.push(`${day}.${new Date(options.eventDate).getMonth() + 1}.${year}`);
    suggestions.push(`${venue}${day}${new Date(options.eventDate).getMonth() + 1}${year.slice(-2)}`);
  }
  
  // Remove duplicates and return first 4
  return Array.from(new Set(suggestions)).slice(0, 4);
}

/**
 * Validate if a password meets the security requirements
 */
export function validatePassword(password: string, config: Partial<PasswordConfig> = {}): {
  isValid: boolean;
  errors: string[];
  score: number;
} {
  const fullConfig = { ...getDefaultConfig(), ...config };
  const errors: string[] = [];
  let score = 0;

  // Length check
  if (password.length < fullConfig.minLength) {
    errors.push(`Password must be at least ${fullConfig.minLength} characters long`);
  } else {
    score += 1;
  }

  // Character requirements
  if (fullConfig.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain uppercase letters');
  } else if (fullConfig.requireUppercase) {
    score += 1;
  }

  if (fullConfig.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain lowercase letters');
  } else if (fullConfig.requireLowercase) {
    score += 1;
  }

  if (fullConfig.requireNumbers && !/[0-9]/.test(password)) {
    errors.push('Password must contain numbers');
  } else if (fullConfig.requireNumbers) {
    score += 1;
  }

  if (fullConfig.requireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>?]/.test(password)) {
    errors.push('Password must contain special characters');
  } else if (fullConfig.requireSpecialChars) {
    score += 1;
  }

  return {
    isValid: errors.length === 0,
    errors,
    score
  };
}