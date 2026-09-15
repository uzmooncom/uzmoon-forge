import React, { useEffect, useState } from "react";
import type { AppState } from "@shared/types.js";
import WelcomeScreen from "./screens/WelcomeScreen.js";
import ConnectAgentScreen from "./screens/ConnectAgentScreen.js";
import ChatScreen from "./screens/ChatScreen.js";
import AgentProfilesModal from "./components/AgentProfilesModal.js";

type Screen = "loading" | "welcome" | "connect" | "chat";

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("loading");
  const [appState, setAppState] = useState<AppState | null>(null);

  useEffect(() => {
    void (async () => {
      const state = await window.forgeApi.getAppState();
      setAppState(state);

      if (state.onboardingComplete && state.agentConfigId) {
        // Verify config still exists
        const cfg = await window.forgeApi.getConfig(state.agentConfigId);
        const hasKey = await window.forgeApi.hasSecret(state.agentConfigId);
        if (cfg && hasKey) {
          setScreen("chat");
          return;
        }
        // Config missing or corrupted — go back to connect
        setScreen("connect");
        return;
      }

      if (!state.onboardingComplete) {
        setScreen("welcome");
        return;
      }

      setScreen("connect");
    })();
  }, []);

  const handleWelcomeContinue = (): void => {
    setScreen("connect");
  };

  const handleConnectComplete = (newState: AppState): void => {
    setAppState(newState);
    setScreen("chat");
  };

  const [showProfilesModal, setShowProfilesModal] = useState(false);

  if (screen === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d0d0f]">
        <div className="h-1 w-24 overflow-hidden rounded-full bg-[#1a1a1e]">
          <div className="h-full animate-pulse rounded-full bg-[#6366f1]" />
        </div>
      </div>
    );
  }

  if (screen === "welcome") {
    return <WelcomeScreen onContinue={handleWelcomeContinue} />;
  }

  if (screen === "connect") {
    return (
      <ConnectAgentScreen
        initialConfigId={appState?.agentConfigId ?? null}
        onComplete={handleConnectComplete}
      />
    );
  }

  return (
    <>
      <ChatScreen
        onOpenSettings={() => setShowProfilesModal(true)}
      />
      {showProfilesModal && (
        <AgentProfilesModal
          onClose={() => setShowProfilesModal(false)}
        />
      )}
    </>
  );
}