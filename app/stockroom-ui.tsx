"use client";
import {
  Children,
  isValidElement,
  useId,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

// Keeps each existing controlled field's value semantics while using the same Radix select.
export function Choice({
  value,
  onValueChange,
  children,
  label,
  disabled,
  className,
  id: providedId,
}: {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const id = useId();
  const options = Children.toArray(children).filter(
    isValidElement,
  ) as ReactElement<{
    value?: string | number;
    children: ReactNode;
    disabled?: boolean;
  }>[];
  return (
    <Select
      value={String(value)}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        id={providedId ?? id}
        className={className ?? "w-full"}
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => {
          const optionValue = String(
            option.props.value ?? option.props.children,
          );
          return (
            <SelectItem
              key={optionValue}
              value={optionValue}
              disabled={option.props.disabled}
            >
              {option.props.children}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
export function FormField({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
