import React, { useState, useCallback } from 'react';
import { Key, RefreshCw, Copy, Check, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { generateEventPassword, generatePasswordSuggestions, validatePassword } from '../../utils/passwordGenerator';
import { Button } from './Button';

interface PasswordGeneratorProps {
  eventName?: string;
  eventDate?: string;
  eventType?: string;
  onPasswordGenerated: (password: string) => void;
  className?: string;
  disabled?: boolean;
  passwordComplexity?: 'simple' | 'moderate' | 'strong' | 'very_strong';
}

export const PasswordGenerator: React.FC<PasswordGeneratorProps> = ({
  eventName = '',
  eventDate = '',
  eventType = 'wedding',
  onPasswordGenerated,
  className = '',
  disabled = false,
  passwordComplexity = 'moderate'
}) => {
  const { t } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const generatePassword = useCallback(() => {
    setIsGenerating(true);
    
    // Simulate some processing time for better UX
    setTimeout(() => {
      const config = {
        complexity: passwordComplexity,
        minLength: passwordComplexity === 'simple' ? 6 : passwordComplexity === 'moderate' ? 8 : 12,
        requireSpecialChars: passwordComplexity === 'very_strong'
      };
      
      const password = generateEventPassword({
        eventName,
        eventDate,
        eventType,
        config
      });
      
      onPasswordGenerated(password);
      setIsGenerating(false);
    }, 300);
  }, [eventName, eventDate, eventType, passwordComplexity, onPasswordGenerated]);

  const generateSuggestions = useCallback(() => {
    const newSuggestions = generatePasswordSuggestions({
      eventName,
      eventDate,
      eventType
    });
    setSuggestions(newSuggestions);
    setShowSuggestions(true);
  }, [eventName, eventDate, eventType]);

  const copyToClipboard = async (password: string, index: number) => {
    try {
      await navigator.clipboard.writeText(password);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = password;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    }
  };

  const selectPassword = (password: string) => {
    onPasswordGenerated(password);
    setShowSuggestions(false);
  };

  const getPasswordStrength = (password: string) => {
    const validation = validatePassword(password, { 
      complexity: passwordComplexity,
      minLength: passwordComplexity === 'simple' ? 6 : passwordComplexity === 'moderate' ? 8 : 12
    });
    
    if (validation.score <= 1) return { label: t('passwordGenerator.weak'), color: 'text-red-600' };
    if (validation.score <= 2) return { label: t('passwordGenerator.fair'), color: 'text-yellow-600' };
    if (validation.score <= 3) return { label: t('passwordGenerator.good'), color: 'text-blue-600' };
    return { label: t('passwordGenerator.strong'), color: 'text-green-600' };
  };

  return (
    <div className={`relative ${className}`}>
      {/* Generate Button */}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={generatePassword}
          disabled={disabled || isGenerating}
          className="flex items-center gap-2"
        >
          {isGenerating ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Key className="w-4 h-4" />
          )}
          {isGenerating ? t('passwordGenerator.generating') : t('passwordGenerator.generatePassword')}
        </Button>
        
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={generateSuggestions}
          disabled={disabled}
          className="flex items-center gap-2"
          title={t('passwordGenerator.showSuggestions')}
        >
          <Zap className="w-4 h-4" />
          {t('passwordGenerator.moreOptions')}
        </Button>
      </div>

      {/* Password Suggestions Modal */}
      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-2 z-50">
          <div className="bg-white border border-neutral-200 rounded-lg shadow-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-neutral-900">{t('passwordGenerator.suggestions')}</h3>
              <button
                onClick={() => setShowSuggestions(false)}
                className="text-neutral-400 hover:text-neutral-600"
              >
                ×
              </button>
            </div>
            
            <div className="space-y-2">
              {suggestions.map((password, index) => {
                const strength = getPasswordStrength(password);
                return (
                  <div
                    key={index}
                    className="flex items-center justify-between p-2 border border-neutral-100 rounded-md hover:bg-neutral-50"
                  >
                    <div className="flex-1 min-w-0">
                      <code className="text-sm font-mono text-neutral-800 break-all">
                        {password}
                      </code>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-xs font-medium ${strength.color}`}>
                          {strength.label}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {password.length} {t('passwordGenerator.characters')}
                        </span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-1 ml-2">
                      <button
                        onClick={() => copyToClipboard(password, index)}
                        className="p-1 text-neutral-400 hover:text-neutral-600"
                        title={t('passwordGenerator.copyPassword')}
                      >
                        {copiedIndex === index ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </button>
                      
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => selectPassword(password)}
                      >
                        {t('passwordGenerator.use')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            
            <div className="mt-3 p-2 bg-blue-50 rounded-md">
              <p className="text-xs text-blue-800">
                <strong>{t('passwordGenerator.pattern')}</strong> {t('passwordGenerator.patternDescription')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PasswordGenerator;
