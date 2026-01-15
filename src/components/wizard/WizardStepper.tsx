import { WizardStep, WIZARD_STEPS } from '@/types/database';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

interface WizardStepperProps {
  currentStep: WizardStep;
  completedSteps: WizardStep[];
  onStepClick?: (step: WizardStep) => void;
}

export function WizardStepper({ currentStep, completedSteps, onStepClick }: WizardStepperProps) {
  const currentIndex = WIZARD_STEPS.findIndex(s => s.id === currentStep);

  return (
    <nav className="w-full">
      <ol className="flex items-center justify-between">
        {WIZARD_STEPS.map((step, index) => {
          // Only show as completed if it's before the current step
          const isCompleted = completedSteps.includes(step.id) && index < currentIndex;
          const isCurrent = step.id === currentStep;
          const isPast = index < currentIndex;
          const isClickable = isPast;

          return (
            <li key={step.id} className="flex-1 relative">
              <div className="flex flex-col items-center">
                <button
                  onClick={() => isClickable && onStepClick?.(step.id)}
                  disabled={!isClickable}
                  className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all",
                    isCompleted && "bg-primary text-primary-foreground",
                    isCurrent && !isCompleted && "bg-primary text-primary-foreground ring-4 ring-primary/20",
                    !isCurrent && !isCompleted && "bg-muted text-muted-foreground",
                    isClickable && "cursor-pointer hover:ring-2 hover:ring-primary/30"
                  )}
                >
                  {isCompleted ? (
                    <Check className="w-5 h-5" />
                  ) : (
                    step.number
                  )}
                </button>
                <span 
                  className={cn(
                    "mt-2 text-xs font-medium text-center max-w-[80px]",
                    isCurrent ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {index < WIZARD_STEPS.length - 1 && (
                <div 
                  className={cn(
                    "absolute top-5 left-[calc(50%+24px)] w-[calc(100%-48px)] h-0.5",
                    isPast || isCompleted ? "bg-primary" : "bg-border"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}