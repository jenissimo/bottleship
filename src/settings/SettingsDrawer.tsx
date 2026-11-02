import React from "react";
import {
  Monitor,
  SpeakerHigh,
  Keyboard,
  HardDrive,
  Globe,
  Terminal,
  Info,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { rescanGamepads } from "../gamepad-cache";
import SettingsAboutSection from "./SettingsAboutSection";
import SettingsAdvancedSection from "./SettingsAdvancedSection";
import SettingsAudioSection from "./SettingsAudioSection";
import SettingsGraphicsSection from "./SettingsGraphicsSection";
import SettingsInputSection from "./SettingsInputSection";
import SettingsNetworkSection from "./SettingsNetworkSection";
import SettingsStorageSection from "./SettingsStorageSection";
import type { SettingsDrawerProps, SettingsSectionId } from "./types";
import { cx } from "../ui/cx";
import { CloseButton } from "../ui/CloseButton";
import { Spacer } from "../ui/Spacer";
import s from "./SettingsDrawer.module.css";
import os from "../ui/Overlay/Overlay.module.css";

export type { SettingsDrawerProps } from "./types";

const SECTIONS: Array<{ id: SettingsSectionId; icon: Icon; label: string }> = [
  { id: "graphics", icon: Monitor, label: "Display & Graphics" },
  { id: "audio", icon: SpeakerHigh, label: "Audio" },
  { id: "input", icon: Keyboard, label: "Input" },
  { id: "network", icon: Globe, label: "Network" },
  { id: "storage", icon: HardDrive, label: "Library & Storage" },
  { id: "advanced", icon: Terminal, label: "Advanced" },
  { id: "about", icon: Info, label: "About" },
];

const SECTION_TITLE: Record<SettingsSectionId, string> = {
  graphics: "Display & Graphics",
  audio: "Audio",
  input: "Input",
  network: "Network",
  storage: "Library & Storage",
  advanced: "Advanced",
  about: "About",
};

export default function SettingsDrawer(props: SettingsDrawerProps): React.ReactElement {
  const { isOpen, onClose } = props;
  const [section, setSection] = React.useState<SettingsSectionId>("graphics");

  React.useEffect(() => {
    if (!isOpen) return;
    rescanGamepads();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  return (
    <div
      className={cx(os, "overlay", isOpen && "is-open")}
      style={{ background: "rgba(2,5,8,.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cx(s, "drawer", isOpen && "is-open")}
        onClick={(e) => e.stopPropagation()}
      >
        <nav className={s["drawer__nav"]}>
          <div className={s["drawer__brand"]}>Settings</div>
          {SECTIONS.map((sec) => {
            const Icon = sec.icon;
            return (
              <a
                key={sec.id}
                className={cx(s, "navitem", section === sec.id && "is-active")}
                onClick={() => setSection(sec.id)}
                role="button"
              >
                <span className={s["ic"]}>
                  <Icon size={17} aria-hidden />
                </span>
                <span>{sec.label}</span>
              </a>
            );
          })}
        </nav>

        <div className={s["drawer__main"]}>
          <div className={s["drawer__head"]}>
            <h2>{SECTION_TITLE[section]}</h2>
            <Spacer />
            <CloseButton onClick={onClose} aria-label="Close settings">
              <X size={16} aria-hidden />
            </CloseButton>
          </div>
          <div className={s["drawer__body"]}>
            {section === "graphics" && <SettingsGraphicsSection {...props} />}
            {section === "audio" && <SettingsAudioSection {...props} />}
            {section === "input" && <SettingsInputSection {...props} active={isOpen && section === "input"} />}
            {section === "network" && <SettingsNetworkSection {...props} />}
            {section === "storage" && <SettingsStorageSection active={isOpen && section === "storage"} />}
            {section === "advanced" && <SettingsAdvancedSection {...props} />}
            {section === "about" && <SettingsAboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
