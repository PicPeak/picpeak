import React from 'react';
import { motion } from 'framer-motion';

interface StorySceneProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  fullWidth?: boolean;
}

export const StoryScene: React.FC<StorySceneProps> = ({
  title,
  subtitle,
  children,
  className = '',
  fullWidth = false
}) => {
  return (
    <section className={`story-scene ${fullWidth ? 'full-width' : ''} ${className}`}>
      {title && (
        <div className="story-scene-header">
          <motion.h2
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="story-scene-title"
          >
            {title}
          </motion.h2>
          {subtitle && (
            <motion.p
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              className="story-scene-subtitle"
            >
              {subtitle}
            </motion.p>
          )}
        </div>
      )}
      {children}
    </section>
  );
};
