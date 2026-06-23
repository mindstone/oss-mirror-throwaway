import React, { useState } from 'react';
import {
  MessageCircle,
  AlignLeft,
  HelpCircle,
  AlertCircle,
  CheckSquare,
  FileText,
  ChevronRight,
  X
} from 'lucide-react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  FloatingOverlay,
  FloatingFocusManager,
} from '@floating-ui/react';
import { Button } from '@renderer/components/ui/Button';
import './AskSparkButton.css';

export interface AskSparkOption {
  id: string;
  label: string;
  prompt: string;
  icon: React.ReactNode;
}

export const ASK_SPARK_OPTIONS: AskSparkOption[] = [
  {
    id: 'summarise',
    label: 'Summarise so far',
    prompt: "Summarise what we've covered in this meeting so far.",
    icon: <AlignLeft size={16} />
  },
  {
    id: 'open-questions',
    label: 'Find open questions',
    prompt: "What open questions have come up in this meeting?",
    icon: <HelpCircle size={16} />
  },
  {
    id: 'elephant',
    label: 'Name the elephant',
    prompt: "What's the elephant in the room in this meeting?",
    icon: <AlertCircle size={16} />
  },
  {
    id: 'next-steps',
    label: 'Draft next steps',
    prompt: "Draft the next steps from this meeting.",
    icon: <CheckSquare size={16} />
  },
  {
    id: 'prep-notes',
    label: 'Show my prep notes',
    prompt: "Show me my prep notes for this meeting.",
    icon: <FileText size={16} />
  }
];

export interface AskSparkButtonProps {
  isOnline: boolean;
  isPulsing: boolean;
  rateLimited: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSubmit: (prompt: string, label: string) => void;
}

export function AskSparkButton({
  isOnline,
  isPulsing,
  rateLimited,
  disabled,
  disabledReason,
  onSubmit
}: AskSparkButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    middleware: [
      offset(8),
      flip({ padding: 16 }),
      shift({ padding: 16 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context, {
    enabled: !disabled
  });
  const dismiss = useDismiss(context);
  const role = useRole(context);

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const handleSelect = (option: AskSparkOption) => {
    setIsOpen(false);
    onSubmit(option.prompt, option.label);
  };

  let subtitle = 'Pick a question. Answers stay here, not in the call.';
  if (!isOnline) {
    subtitle = 'Pick a question. Spark will answer when reconnected.';
  } else if (rateLimited) {
    subtitle = 'Voice trigger is paused. The button still works.';
  }

  return (
    <>
      <Button
        ref={refs.setReference}
        variant="secondary"
        size="sm"
        className={`ask-spark-button ${isPulsing ? 'ask-spark-button--pulsing' : ''}`}
        aria-label="Ask Spark during this meeting"
        aria-description="Opens meeting questions you can send to Spark."
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        {...getReferenceProps()}
      >
        <MessageCircle size={16} className="ask-spark-button__icon" />
        <span className="ask-spark-button__label">Ask Spark</span>
      </Button>

      {isOpen && (
        <FloatingPortal>
          <FloatingOverlay lockScroll className="ask-spark-picker__overlay">
            <FloatingFocusManager context={context}>
              <div
                ref={refs.setFloating}
                style={floatingStyles}
                className="ask-spark-picker"
                {...getFloatingProps()}
              >
                <div className="ask-spark-picker__header">
                  <div className="ask-spark-picker__title">Ask Spark</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ask-spark-picker__close"
                    onClick={() => setIsOpen(false)}
                    aria-label="Close Ask Spark"
                  >
                    <X size={16} />
                  </Button>
                </div>
                <div className="ask-spark-picker__subtitle">{subtitle}</div>
                
                <div className="ask-spark-picker__options">
                  {ASK_SPARK_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      className="ask-spark-picker__option"
                      onClick={() => handleSelect(option)}
                    >
                      <span className="ask-spark-picker__option-icon">{option.icon}</span>
                      <span className="ask-spark-picker__option-label">{option.label}</span>
                      <ChevronRight size={16} className="ask-spark-picker__option-chevron" />
                    </button>
                  ))}
                </div>
              </div>
            </FloatingFocusManager>
          </FloatingOverlay>
        </FloatingPortal>
      )}
    </>
  );
}
