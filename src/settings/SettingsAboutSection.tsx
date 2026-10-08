import React from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { SettingsSection } from "./SettingsRow";
import s from "./SettingsAboutSection.module.css";

export default function SettingsAboutSection(): React.ReactElement {
  return (
    <SettingsSection>
      <div className={s["about"]}>
        <img src="/bottleship_logo.png" className={s["about__bottle"]} alt="BottleShip" />
        <div className={s["about__title"]}>
          Bottle<b>Ship</b>
        </div>
        <div className={s["about__lede"]}>
          Run native Windows games of 1996–2004 in your browser — no install, no VM, no upload.
        </div>
        <p className={s["about__story"]}>
          Like a ship sealed in glass, BottleShip keeps each game whole — its files, its registry,
          its Windows — in a self-contained <b>.wgb</b>. The x86 runs under HLE in a Web Worker,
          legacy DirectDraw/Direct3D is translated live to WebGPU, and a copy-on-write OPFS
          filesystem keeps the original untouched.
        </p>
        <div className={s["badges"]}>
          <span className={s["tech"]}>x86 HLE / v86</span>
          <span className={s["tech"]}>WebAssembly</span>
          <span className={s["tech"]}>WebGPU · WGSL</span>
          <span className={s["tech"]}>AudioWorklet</span>
          <span className={s["tech"]}>OPFS · CoW</span>
        </div>
        <div className={s["about__priv"]}>
          <ShieldCheck size={14} aria-hidden />
          Local only — your games never leave this machine.
        </div>
        <div className={s["about__legal"]}>
          The online library hosts only demos, shareware and other redistributable releases.
          Takedown or contact:{" "}
          <a href="mailto:jenissimo+bottleship@gmail.com">jenissimo+bottleship@gmail.com</a>.
        </div>
        <div className={s["about__ver"]}>v{__APP_VERSION__} · build {__BUILD_SHA__} · Apache-2.0</div>
      </div>
    </SettingsSection>
  );
}
