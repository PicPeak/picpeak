import React from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  fullScreen?: boolean;
  className?: string;
}

export const Loading: React.FC<LoadingProps> = ({
  size = 'md',
  text,
  fullScreen = false,
  className,
}) => {
  const sizeStyles = {
    sm: 'h-4 w-4',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  };

  const content = (
    <div className={clsx('flex flex-col items-center justify-center', className)}>
      <Loader2 className={clsx('animate-spin text-accent', sizeStyles[size])} />
      {text && (
        <p className="mt-4 text-sm text-neutral-600">{text}</p>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="fixed inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center z-50">
        {content}
      </div>
    );
  }

  return content;
};

interface LoadingSkeletonProps {
  className?: string;
  count?: number;
  type?: 'text' | 'card' | 'image';
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  className,
  count = 1,
  type = 'text',
}) => {
  const baseStyles = 'skeleton';
  
  const typeStyles = {
    text: 'h-4 w-full rounded',
    card: 'h-32 w-full rounded-xl',
    image: 'aspect-square w-full rounded-lg',
  };

  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={clsx(
            baseStyles,
            typeStyles[type],
            className
          )}
        />
      ))}
    </>
  );
};