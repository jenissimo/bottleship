import { X } from "@phosphor-icons/react";
import React from "react";
import { cx } from "../cx";
import s from "./Modal.module.css";

interface ModalProps {
  children: React.ReactNode;
  /** Extra class applied to .modal-content (e.g. feature size class) */
  className?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  role?: string;
  "aria-modal"?: boolean;
  "aria-label"?: string;
}

export function ModalOverlay({
  children,
  onKeyDown,
}: {
  children: React.ReactNode;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}): React.ReactElement {
  return (
    <div className={s["modal-overlay"]} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export function ModalContent({
  children,
  className,
  ...rest
}: ModalProps): React.ReactElement {
  return (
    <div className={cx(s, "modal-content", className)} {...rest}>
      {children}
    </div>
  );
}

export function ModalHeader({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <div className={s["modal-header"]}>{children}</div>;
}

export function ModalClose({
  onClick,
}: {
  onClick: () => void;
}): React.ReactElement {
  return (
    <button className={s["modal-close"]} onClick={onClick} aria-label="Close">
      <X size={16} aria-hidden />
    </button>
  );
}

export function ModalBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cx(s, "modal-body", className)}>{children}</div>
  );
}
