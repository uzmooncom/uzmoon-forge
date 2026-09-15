import React from "react";

interface Props {
  onContinue: () => void;
}

export default function WelcomeScreen({ onContinue }: Props): React.ReactElement {
  return (
    <div className="flex h-full flex-col bg-[#0d0d0f]">
      {/* macOS drag region */}
      <div className="drag-region h-10 w-full" />

      {/* Centered content */}
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16">
        {/* Logo mark */}
        <div className="mb-8 flex items-center justify-center">
          <img
            src="./assets/logo.png"
            alt="Uzmoon Forge"
            width={80}
            height={80}
            className="select-none"
            style={{ imageRendering: "auto" }}
          />
        </div>

        {/* Title */}
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-[#e8e8ec]">
          Uzmoon Forge
        </h1>

        {/* Tagline */}
        <p className="mb-12 max-w-xs text-center text-sm leading-relaxed text-[#7a7a85]">
          Connect your own agent and start building.
        </p>

        {/* CTA */}
        <button
          onClick={onContinue}
          className="no-drag flex h-10 w-52 items-center justify-center rounded-lg bg-[#6366f1] text-sm font-medium text-white transition-colors hover:bg-[#7578f3] active:bg-[#5254cc] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366f1]"
        >
          Continue
        </button>
      </div>

      {/* Bottom version */}
      <div className="pb-6 text-center">
        <span className="text-[11px] text-[#3a3a42]">v0.1.0</span>
      </div>
    </div>
  );
}