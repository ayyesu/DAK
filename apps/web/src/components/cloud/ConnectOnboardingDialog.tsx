import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthSessionState,
} from "@dak/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentSession, readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";

/**
 * Post-sign-in onboarding wizard for DAK Connect. Opens on every in-session
 * sign-in — sign-out removes the connected relay environments, so each new
 * session starts with no devices to reach. It first prompts to publish this
 * environment (managed tunnel + agent activity, both defaulting on) when the
 * current session is authorized to manage the relay link, then lists the
 * account's DAK Connect environments so every device can be connected right
 * away. A cold load with a restored session does not count as a sign-in.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "devices";

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const { isReady: environmentsReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primarySessionState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const canManageRelay = canReadRelay && canWriteRelay;
  // The wizard is only offered when we know the answer; opening the wizard
  // before the session state resolves would let the step set change mid-flight.
  const sessionScopesKnown =
    primaryEnvironmentId === null ? environmentsReady : primarySessionState._tag !== "Initial";

  const controller = useCloudLinkController();
  const { operationError, linkState } = controller;
  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const prefilledFromLinkStateRef = useRef(false);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  const optOutAccounts = optOutState.optOutAccounts;

  // Every sign-in or account switch that completes during this session
  // requests the wizard — account transitions clear the connected relay
  // environments, so each new session starts with no devices to reach. A cold
  // load observes undefined → account and must not re-prompt.
  useEffect(() => {
    if (!isLoaded) return;
    // A loaded-but-incomplete snapshot (signed in, user id not yet populated)
    // must not be recorded as signed-out — the next render would then look
    // like a fresh sign-in on a cold load.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount !== undefined && previousAccount !== nextAccount && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  // Open once the session scopes resolve. Accounts that chose "Don't show this
  // again" are skipped.
  useEffect(() => {
    if (requestedAccount === null || openForAccount !== null) return;
    if (optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
      return;
    }
    if (!sessionScopesKnown) return;
    setRequestedAccount(null);
    prefilledFromLinkStateRef.current = false;
    setExposeEnvironment(true);
    setDontShowAgain(false);
    setOpenForAccount(requestedAccount);
  }, [canManageRelay, optOutAccounts, openForAccount, requestedAccount, sessionScopesKnown]);

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
      setRequestedAccount(null);
    }
  }, [isSignedIn, openForAccount, requestedAccount, userId]);

  // Toggles default on, but an environment that is already linked should show
  // its actual configuration instead of silently proposing to rewrite it.
  // Only when the link belongs to the account being onboarded, though — after
  // an account switch the cached link state can still describe the previous
  // account's setup.
  const linkStateData = linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (linkStateData.linked && linkStateData.cloudUserId === openForAccount) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    // Keep the wizard up while a link request is in flight so its outcome
    // (and any failure) stays visible.
    if (isApplying) return;
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyExposeSelection = async () => {
    if (isApplying) return;
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    ) {
      setOpenForAccount(null);
      return;
    }
    if (linkStateData === null || controller.linkState.error !== null) return;
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: exposeEnvironment,
    });
    setIsApplying(false);
    if (!ok) return;
    toastManager.add({
      type: "success",
      title: "DAK Connect enabled",
      description: exposeEnvironment
        ? "This environment is available to your other devices through DAK Connect."
        : "This environment is no longer available through DAK Connect.",
    });
    setOpenForAccount(null);
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        // Keep the dialog up while a link request is in flight so its outcome
        // (and any failure) stays visible.
        if (!open && !isApplying) complete();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Set up DAK Connect"
          description={
            <>
              Mesh your devices together and connect the rest, all in one place.
            </>
          }
        >
          <WizardSteps
            steps={["devices"].map((id) => STEP_LABELS[id as OnboardingStep])}
            currentStep={0}
            isStepDisabled={() => isApplying}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="rounded-lg border">
            <OnboardingToggleRow
              title="Publish this environment"
              description="Make this environment available to your other devices through DAK Connect."
              checked={exposeEnvironment}
              disabled={isApplying || !canManageRelay || linkStateData === null}
              onCheckedChange={(enabled) => {
                if (
                  primaryEnvironmentId !== null &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                )
                  setExposeEnvironment(enabled);
              }}
            />
          </div>
          {operationError ? <p className="text-xs text-destructive">{operationError}</p> : null}
          <DevicesStep />
        </WizardPanel>
        <WizardFooter>
          {linkStateData !== null && (
            <Button
              disabled={isApplying || !canManageRelay || linkStateData === null}
              onClick={() => void applyExposeSelection()}
            >
              {isApplying ? "Applying…" : "Continue"}
            </Button>
          )}
          <Button disabled={isApplying} onClick={complete}>
            Done
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  devices: "Connect devices",
};

function OnboardingToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No other environments are published to your account yet. Publish one from another device
            and it will show up here.
          </p>
        }
      />
    </div>
  );
}
