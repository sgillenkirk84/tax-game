"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";

type PlayerSession = {
  id?: string;
  resumeToken?: string;
  sessionCode: string;
  displayName: string;
  joinedAt: string;
};

type SavedSetup = {
  pathwayId: string | null;
  startingDecisionId: string | null;
  status: "joined" | "playing";
};

type SessionRecord = {
  id: string;
  name: string;
  code: string;
  seatCount: number;
  createdAt: string;
};

type RolePathway = {
  id: string;
  name: string;
  shortDescription: string;
  startingIncomeType: string;
  startingCondition: string;
  advantageName: string;
  advantageRule: string;
  challengeName: string;
  challengeRule: string;
  incomeRule: string;
  resultMessage: string;
  graphic: string;
  developerNotes: string;
};

type GameChoice = {
  id: string;
  label: string;
  summary: string;
  incomeDelta: number;
  taxDelta: number;
  savingsDelta: number;
};

const PLAYER_STORAGE_KEY = "my-tax-life-player";
const SESSIONS_KEY = "my-tax-life-sessions";

const rolePathways: RolePathway[] = [
  {
    id: "PATH-001",
    name: "Corporate Climber",
    shortDescription: "You focus on moving up financially throughout your career.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Draw one Income card in Round 1 and use its dollar amount as your starting primary income.",
    advantageName: "Always Climbing",
    advantageRule: "Your primary income can never decrease. Each round draw a new Income card and keep the higher amount.",
    challengeName: "Career Plateau",
    challengeRule: "A lower Income card does not reduce your income, but it also provides no increase that round.",
    incomeRule: "Store your current primary income and use max(currentPrimaryIncome, newlyDrawnIncomeAmount).",
    resultMessage: "You kept climbing. Even when new opportunities offered less income, you maintained the highest income level you had reached.",
    graphic: "Career ladder + upward arrow",
    developerNotes: "Preserve underlying tax classification for tax calculations even though the pathway comparison uses only the dollar amount.",
  },
  {
    id: "PATH-002",
    name: "Entrepreneur",
    shortDescription: "You pursue additional income by building businesses and taking on new ventures.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Draw one Income card and use its dollar amount as your primary income.",
    advantageName: "Multiple Opportunities",
    advantageRule: "Once per regular-life round, draw one additional Income card and keep it only if it is Business Income.",
    challengeName: "More Tax Complexity",
    challengeRule: "Additional business income may introduce business/self-employment tax rules and extra recordkeeping.",
    incomeRule: "Primary income may come from either income category, but maximum one additional pathway-generated draw per round.",
    resultMessage: "Your willingness to pursue new opportunities gave you additional ways to earn income throughout your financial journey.",
    graphic: "Lightbulb + storefront / laptop",
    developerNotes: "Keep tax classification of retained cards intact and preserve business-specific tax treatment through Tax Rules.",
  },
  {
    id: "PATH-003",
    name: "Caregiver",
    shortDescription: "Supporting another person remains part of your financial life.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Begin the game with one permanent pathway-dependent.",
    advantageName: "Family First",
    advantageRule: "You always have at least one dependent throughout the entire game, including retirement.",
    challengeName: "Family Responsibilities",
    challengeRule: "Having a dependent does not automatically make household expenses deductible; benefits still depend on Tax Rules.",
    incomeRule: "Set minimumDependents = 1 for the entire game. Other dependents may be added or removed, but total dependents cannot fall below one.",
    resultMessage: "Caring for another person remained part of your financial life from your working years through retirement.",
    graphic: "Family / caregiver icon",
    developerNotes: "Track pathway dependents separately from life event dependents so permanent dependents are never accidentally removed.",
  },
  {
    id: "PATH-004",
    name: "Home Builder",
    shortDescription: "Homeownership becomes a major part of your financial journey.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Begin the game with Homeowner status active.",
    advantageName: "Homeowner Head Start",
    advantageRule: "You begin the game eligible for homeowner-related deduction scenarios.",
    challengeName: "Itemizing Isn't Automatic",
    challengeRule: "Owning a home does not automatically mean itemizing is better than taking the standard deduction.",
    incomeRule: "Draw Income cards normally; if Bought a Home appears while already a homeowner, redraw.",
    resultMessage: "Homeownership gave you additional tax decisions, but owning a home did not automatically mean a bigger deduction.",
    graphic: "House + tax document",
    developerNotes: "Homeowner status persists until removed by a life event; it enables scenarios without forcing itemization.",
  },
  {
    id: "PATH-005",
    name: "Lifelong Learner",
    shortDescription: "Education and career development remain recurring parts of your financial life.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Begin with normal income rules and Education Eligibility status active.",
    advantageName: "Education Advantage",
    advantageRule: "When an Education Opportunity occurs, receive the pathway's enhanced education treatment defined in Tax Rules.",
    challengeName: "Eligibility Matters",
    challengeRule: "Education spending does not automatically qualify for a tax benefit.",
    incomeRule: "Draw Income cards normally; education-related benefits are evaluated using the current Tax Rules.",
    resultMessage: "Investing in education created additional tax decisions throughout your working life.",
    graphic: "Graduation cap + briefcase",
    developerNotes: "Do not hard-code an education credit or deduction amount here; Tax Rules should define the applicable benefit for the year.",
  },
  {
    id: "PATH-006",
    name: "Side Hustler",
    shortDescription: "You earn money from multiple sources and those income sources can change throughout your career.",
    startingIncomeType: "Any Income Cards",
    startingCondition: "Draw two Income cards each regular-life round.",
    advantageName: "Two Income Streams",
    advantageRule: "Draw two Income cards each round and use both income amounts. The cards may represent any combination of income types.",
    challengeName: "More Income, More Complexity",
    challengeRule: "Both income amounts are included in the player's tax calculation, so multiple income sources create a more complicated tax situation.",
    incomeRule: "Draw exactly two Income cards at each regular-life round, preserve each card separately, and keep both in the total income calculation.",
    resultMessage: "Your income came from multiple sources throughout your career, giving you more income opportunities and more tax situations to manage.",
    graphic: "Briefcase + laptop / two income arrows",
    developerNotes: "Draw exactly two regular Income cards per round and keep each source separate so the engine preserves the underlying tax classification.",
  },
  {
    id: "PATH-007",
    name: "Investor",
    shortDescription: "Building investments is a major part of your long-term financial strategy.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Begin the game holding one Starter Investment asset.",
    advantageName: "Head Start Investing",
    advantageRule: "Start the game with one Starter Investment token and let it follow the recurring-income and retirement rules defined for that asset.",
    challengeName: "Investment Income Counts",
    challengeRule: "Investment income must still be included according to the simulation's investment tax rules.",
    incomeRule: "Draw Income cards normally and add recurring investment income from held investments into your financial state.",
    resultMessage: "Starting early gave your investments more opportunities to influence both your annual income and your retirement.",
    graphic: "Investment chart + growing coin/plant",
    developerNotes: "Reference the Starter Investment asset rather than duplicating its values so there is one source of truth for the asset rules.",
  },
  {
    id: "PATH-008",
    name: "Early Retiree",
    shortDescription: "You plan your financial life around reaching retirement earlier than other players.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Begin under normal working-life rules and enter retirement one round earlier than normal.",
    advantageName: "Early Retirement",
    advantageRule: "Access the Retirement deck beginning in Round 4 instead of waiting until Round 5.",
    challengeName: "Fewer Working Years",
    challengeRule: "Entering retirement earlier means fewer regular working-life rounds before your income sources change.",
    incomeRule: "Draw Income cards normally during working-life rounds; once retirement begins, follow Retirement deck rules instead of the normal primary Income draw.",
    resultMessage: "You reached retirement earlier and experienced the shift from working income to retirement income before the other pathways.",
    graphic: "Clock + retirement chair / finish-line icon",
    developerNotes: "Retirement begins in Round 4. This is the defining mechanic of the pathway and affects when retirement income and investment rules apply.",
  },
];

const roleChoiceScenarios: GameChoice[] = [
  {
    id: "take-opportunity",
    label: "Take the opportunity",
    summary: "Lean into your role's advantage and accept the financial tradeoff that comes with it.",
    incomeDelta: 14000,
    taxDelta: 1800,
    savingsDelta: 2100,
  },
  {
    id: "play-safe",
    label: "Play it safe",
    summary: "Keep the simpler path and focus on lower risk with steadier, more predictable financial outcomes.",
    incomeDelta: 6000,
    taxDelta: 1000,
    savingsDelta: 1200,
  },
  {
    id: "adapt-quickly",
    label: "Adapt quickly",
    summary: "Remain flexible and respond to changing life events without locking into one strategy too early.",
    incomeDelta: 9000,
    taxDelta: 1200,
    savingsDelta: 1700,
  },
];

const initialProfile = {
  income: 42000,
  taxes: 6200,
  savings: 2100,
};

function profileForDecision(decisionId: string | null) {
  const choice = roleChoiceScenarios.find((item) => item.id === decisionId);
  if (!choice) {
    return initialProfile;
  }

  return {
    income: initialProfile.income + choice.incomeDelta,
    taxes: Math.max(0, initialProfile.taxes + choice.taxDelta),
    savings: initialProfile.savings + choice.savingsDelta,
  };
}

async function readSavedSetup(player: PlayerSession): Promise<SavedSetup> {
  const response = await fetch("/api/students/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken }),
  });
  const result = (await response.json()) as SavedSetup & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Could not load this player's saved setup.");
  }
  if (
    (result.pathwayId !== null && !rolePathways.some((role) => role.id === result.pathwayId)) ||
    (result.startingDecisionId !== null &&
      !roleChoiceScenarios.some((choice) => choice.id === result.startingDecisionId)) ||
    (result.status !== "joined" && result.status !== "playing")
  ) {
    throw new Error("Saved setup data is invalid. Please contact your teacher.");
  }

  return result;
}

async function saveSetup(
  player: PlayerSession,
  setup: {
    pathwayId: string | null;
    startingDecisionId: string | null;
    setupComplete: boolean;
  }
): Promise<SavedSetup> {
  const response = await fetch("/api/students/setup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: player.id,
      resumeToken: player.resumeToken,
      ...setup,
    }),
  });
  const result = (await response.json()) as SavedSetup & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Could not save this player's setup.");
  }
  if (
    (result.pathwayId !== null && !rolePathways.some((role) => role.id === result.pathwayId)) ||
    (result.startingDecisionId !== null &&
      !roleChoiceScenarios.some((choice) => choice.id === result.startingDecisionId)) ||
    (result.status !== "joined" && result.status !== "playing")
  ) {
    throw new Error("Saved setup data is invalid. Please contact your teacher.");
  }

  return result;
}

export default function StudentGamePage() {
  const router = useRouter();
  const [player, setPlayer] = useState<PlayerSession | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupSaving, setSetupSaving] = useState(false);
  const [persistenceEnabled, setPersistenceEnabled] = useState(false);
  const [legacyPlayer, setLegacyPlayer] = useState(false);
  const [hasSelectedRole, setHasSelectedRole] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState("PATH-001");
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [readyForNextStep, setReadyForNextStep] = useState(false);
  const [profile, setProfile] = useState(initialProfile);
  const setupActionInProgress = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function hydratePlayer() {
      const savedPlayer = window.localStorage.getItem(PLAYER_STORAGE_KEY);

      if (!savedPlayer) {
        startTransition(() => setSetupLoading(false));
        return;
      }

      let parsedPlayer: PlayerSession;
      try {
        parsedPlayer = JSON.parse(savedPlayer) as PlayerSession;
        if (
          typeof parsedPlayer.sessionCode !== "string" ||
          typeof parsedPlayer.displayName !== "string" ||
          typeof parsedPlayer.joinedAt !== "string"
        ) {
          startTransition(() => setSetupLoading(false));
          return;
        }
      } catch {
        startTransition(() => setSetupLoading(false));
        return;
      }

      let matchingSession: SessionRecord | null = null;
      const savedSessions = window.localStorage.getItem(SESSIONS_KEY);
      if (savedSessions) {
        try {
          const sessions = JSON.parse(savedSessions) as SessionRecord[];
          matchingSession = sessions.find((item) => item.code === parsedPlayer.sessionCode) ?? null;
        } catch {
          matchingSession = null;
        }
      }

      if (cancelled) {
        return;
      }

      startTransition(() => {
        setPlayer(parsedPlayer);
        setSession(matchingSession);
      });

      if (!parsedPlayer.id || !parsedPlayer.resumeToken) {
        startTransition(() => {
          setLegacyPlayer(true);
          setSetupLoading(false);
        });
        return;
      }

      try {
        const savedSetup = await readSavedSetup(parsedPlayer);
        if (cancelled) {
          return;
        }
        startTransition(() => {
          setPersistenceEnabled(true);
          setHasSelectedRole(savedSetup.pathwayId !== null);
          if (savedSetup.pathwayId) {
            setSelectedRoleId(savedSetup.pathwayId);
          }
          setSelectedChoice(savedSetup.startingDecisionId);
          setProfile(profileForDecision(savedSetup.startingDecisionId));
          setReadyForNextStep(savedSetup.status === "playing");
          setSetupLoading(false);
        });
      } catch (error) {
        if (!cancelled) {
          startTransition(() => {
            setSetupError(error instanceof Error ? error.message : "Could not load this player's saved setup.");
            setSetupLoading(false);
          });
        }
      }
    }

    void hydratePlayer();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRole = rolePathways.find((role) => role.id === selectedRoleId) ?? rolePathways[0];
  const summaryText = useMemo(() => {
    return `${profile.income.toLocaleString()} income · ${profile.taxes.toLocaleString()} taxes · ${profile.savings.toLocaleString()} savings`;
  }, [profile]);

  function handleReset() {
    window.localStorage.removeItem(PLAYER_STORAGE_KEY);
    router.push("/play");
  }

  function applySavedSetup(setup: SavedSetup) {
    setHasSelectedRole(setup.pathwayId !== null);
    if (setup.pathwayId) {
      setSelectedRoleId(setup.pathwayId);
    }
    setSelectedChoice(setup.startingDecisionId);
    setProfile(profileForDecision(setup.startingDecisionId));
    setReadyForNextStep(setup.status === "playing");
  }

  async function retrySetupLoad() {
    if (!player?.id || !player.resumeToken) {
      return;
    }

    setSetupLoading(true);
    setSetupError(null);
    try {
      const savedSetup = await readSavedSetup(player);
      setPersistenceEnabled(true);
      applySavedSetup(savedSetup);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not load this player's saved setup.");
    } finally {
      setSetupLoading(false);
    }
  }

  async function handleRoleSelection(roleId: string) {
    if (hasSelectedRole || setupActionInProgress.current) {
      return;
    }

    setupActionInProgress.current = true;
    setSetupSaving(true);
    setSetupError(null);
    try {
      if (persistenceEnabled && player) {
        const savedSetup = await saveSetup(player, {
          pathwayId: roleId,
          startingDecisionId: null,
          setupComplete: false,
        });
        if (savedSetup.pathwayId !== roleId) {
          throw new Error("The selected role could not be confirmed as saved.");
        }
      }

      setSelectedRoleId(roleId);
      setHasSelectedRole(true);
      setSelectedChoice(null);
      setReadyForNextStep(false);
      setProfile(initialProfile);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not save the selected role.");
    } finally {
      setupActionInProgress.current = false;
      setSetupSaving(false);
    }
  }

  async function drawStartingDecisionCard() {
    if (!hasSelectedRole || selectedChoice || setupActionInProgress.current) {
      return;
    }

    const randomIndex = Math.floor(Math.random() * roleChoiceScenarios.length);
    const drawnChoice = roleChoiceScenarios[randomIndex];
    setupActionInProgress.current = true;
    setSetupSaving(true);
    setSetupError(null);
    try {
      if (persistenceEnabled && player) {
        const savedSetup = await saveSetup(player, {
          pathwayId: selectedRoleId,
          startingDecisionId: drawnChoice.id,
          setupComplete: false,
        });
        if (savedSetup.startingDecisionId !== drawnChoice.id) {
          throw new Error("The starting decision could not be confirmed as saved.");
        }
      }

      setSelectedChoice(drawnChoice.id);
      setProfile(profileForDecision(drawnChoice.id));
      setReadyForNextStep(false);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not save the starting decision.");
    } finally {
      setupActionInProgress.current = false;
      setSetupSaving(false);
    }
  }

  async function continueToNextStep() {
    if (!selectedChoice || setupActionInProgress.current || readyForNextStep) {
      return;
    }

    setupActionInProgress.current = true;
    setSetupSaving(true);
    setSetupError(null);
    try {
      if (persistenceEnabled && player) {
        const savedSetup = await saveSetup(player, {
          pathwayId: selectedRoleId,
          startingDecisionId: selectedChoice,
          setupComplete: true,
        });
        if (savedSetup.status !== "playing") {
          throw new Error("Setup completion could not be confirmed as saved.");
        }
      }

      setReadyForNextStep(true);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not save setup completion.");
    } finally {
      setupActionInProgress.current = false;
      setSetupSaving(false);
    }
  }

  if (setupLoading) {
    return (
      <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-12 text-[var(--brand-navy)]">
        <div className="mx-auto max-w-xl rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-8 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
          <h1 className="text-2xl font-black">Loading your saved setup...</h1>
        </div>
      </main>
    );
  }

  if (setupError && player?.id && player.resumeToken) {
    return (
      <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-12 text-[var(--brand-navy)]">
        <div className="mx-auto max-w-xl rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-8 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
          <h1 className="text-2xl font-black">Could not confirm your saved setup</h1>
          <p className="mt-3 text-[var(--brand-navy)]/75">{setupError}</p>
          <button
            type="button"
            onClick={retrySetupLoad}
            className="mt-6 rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (!player) {
    return (
      <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-12 text-[var(--brand-navy)]">
        <div className="mx-auto max-w-xl rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-8 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
          <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
            Session Missing
          </p>
          <h1 className="mt-4 text-3xl font-black">No active player session found</h1>
          <p className="mt-3 text-[var(--brand-navy)]/75">
            Please join a session again before continuing to the game flow.
          </p>
          <Link
            href="/play"
            className="mt-6 inline-flex rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
          >
            Join a Session
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-10 text-[var(--brand-navy)]">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
              Student Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-black sm:text-4xl">Welcome, {player.displayName}</h1>
          </div>

          <button
            type="button"
            onClick={handleReset}
            className="rounded-xl border border-[var(--brand-navy)]/20 bg-white px-4 py-2 font-bold text-[var(--brand-navy)] transition hover:bg-[var(--brand-ivory)]"
          >
            Switch Session
          </button>
        </div>

        {legacyPlayer ? (
          <div className="mb-6 rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-4 text-sm text-[var(--brand-navy)]">
            This older player session has no resume token. Setup progress cannot be saved, and this existing registration has not been changed.
          </div>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-7 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                  Session
                </p>
                <h2 className="mt-2 text-2xl font-black">{session?.name ?? "Active session"}</h2>
              </div>

              <div className="rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 px-4 py-2 text-center">
                <div className="text-[10px] font-black uppercase tracking-[0.25em] text-[var(--brand-navy)]/70">
                  Code
                </div>
                <div className="mt-1 text-xl font-black tracking-[0.18em]">{player.sessionCode}</div>
              </div>
            </div>

            {!hasSelectedRole ? (
              <div className="mt-8 rounded-2xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-6">
                <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                  Role Card Step
                </p>
                <h3 className="mt-3 text-3xl font-black">Choose the role card you physically drew</h3>
                <p className="mt-4 text-base leading-relaxed text-[var(--brand-navy)]/80">
                  The player physically draws a role card before the round begins. Select the role that was drawn in the app so the rest of the game can continue with the correct pathway.
                </p>

                <div className="mt-6 grid gap-4">
                  {rolePathways.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      onClick={() => handleRoleSelection(role.id)}
                      disabled={setupSaving}
                      className="w-full rounded-2xl border border-[var(--brand-navy)]/10 bg-white p-4 text-left transition hover:border-[var(--brand-navy)]/30"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-lg font-black text-[var(--brand-navy)]">{role.name}</div>
                          <div className="mt-1 text-sm text-[var(--brand-navy)]/75">{role.shortDescription}</div>
                        </div>
                        <span className="rounded-full bg-[var(--brand-gold)]/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]">
                          {role.id}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                        Drawn Role Card
                      </p>
                      <h3 className="mt-2 text-3xl font-black">{selectedRole.name}</h3>
                    </div>
                    <span className="rounded-full bg-[var(--brand-navy)] px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-white">
                      {selectedRole.id}
                    </span>
                  </div>

                  <p className="mt-4 text-base leading-relaxed text-[var(--brand-navy)]/80">
                    {selectedRole.shortDescription}
                  </p>

                  <div className="mt-5 rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-4 text-sm font-semibold text-[var(--brand-navy)]">
                    {selectedRole.resultMessage}
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--brand-navy)]/10 bg-white p-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                        Starting Income Type
                      </div>
                      <div className="mt-2 text-lg font-black">{selectedRole.startingIncomeType}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                        Starting Condition / Power
                      </div>
                      <div className="mt-2 text-lg font-black">{selectedRole.startingCondition}</div>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4">
                    <div className="rounded-xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-4">
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                        Advantage
                      </div>
                      <div className="mt-2 text-lg font-black">{selectedRole.advantageName}</div>
                      <div className="mt-2 text-sm leading-relaxed text-[var(--brand-navy)]/75">
                        {selectedRole.advantageRule}
                      </div>
                    </div>

                    <div className="rounded-xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-4">
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                        Challenge
                      </div>
                      <div className="mt-2 text-lg font-black">{selectedRole.challengeName}</div>
                      <div className="mt-2 text-sm leading-relaxed text-[var(--brand-navy)]/75">
                        {selectedRole.challengeRule}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--brand-navy)]/10 bg-white p-5">
                  <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                    Starting Decision Card
                  </p>
                  <h4 className="mt-3 text-2xl font-black">Random draw: one-time outcome</h4>

                  {!selectedChoice ? (
                    <div className="mt-5">
                      <button
                        type="button"
                        onClick={drawStartingDecisionCard}
                        disabled={setupSaving}
                        className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
                      >
                        {setupSaving ? "Saving..." : "Draw Starting Decision Card"}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-5">
                      {(() => {
                        const choice = roleChoiceScenarios.find((item) => item.id === selectedChoice);
                        if (!choice) {
                          return null;
                        }

                        return (
                          <div className="rounded-2xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-5">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="text-xl font-black text-[var(--brand-navy)]">{choice.label}</div>
                                <div className="mt-2 text-sm leading-relaxed text-[var(--brand-navy)]/75">
                                  {choice.summary}
                                </div>
                              </div>

                              <div className="text-right text-[10px] font-black uppercase tracking-[0.15em] text-[var(--brand-navy)]/60">
                                <div>Income {choice.incomeDelta >= 0 ? "+" : ""}${choice.incomeDelta}</div>
                                <div>Tax {choice.taxDelta >= 0 ? "+" : ""}${choice.taxDelta}</div>
                                <div>Save {choice.savingsDelta >= 0 ? "+" : ""}${choice.savingsDelta}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {!readyForNextStep ? (
                        <div className="mt-6 flex flex-wrap gap-4">
                          <button
                            type="button"
                            onClick={continueToNextStep}
                            disabled={setupSaving}
                            className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
                          >
                            {setupSaving ? "Saving..." : "Move to the next step"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}

                </div>

                {readyForNextStep ? (
                  <div className="rounded-2xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-4 text-sm font-semibold text-[var(--brand-navy)]">
                    Starting setup complete. This player is ready to proceed to the next game phase.
                    {process.env.NEXT_PUBLIC_ROUND_ONE_ENABLED === "true" ? (
                      <Link
                        href="/play/round-1"
                        className="mt-4 flex w-fit rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
                      >
                        Start Round 1
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className="space-y-6">
            <div className="rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-6 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
              <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                Financial Snapshot
              </p>

              <div className="mt-5 space-y-4 text-sm text-[var(--brand-navy)]/80">
                <div className="flex items-center justify-between border-b border-[var(--brand-navy)]/10 pb-2">
                  <span>Income</span>
                  <strong>${profile.income.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between border-b border-[var(--brand-navy)]/10 pb-2">
                  <span>Taxes</span>
                  <strong>${profile.taxes.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between border-b border-[var(--brand-navy)]/10 pb-2">
                  <span>Savings</span>
                  <strong>${profile.savings.toLocaleString()}</strong>
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-3 text-sm font-semibold text-[var(--brand-navy)]">
                {summaryText}
              </div>
            </div>

            <div className="rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-6 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
              <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                Role Notes
              </p>

              <div className="mt-4 space-y-3 text-sm text-[var(--brand-navy)]/80">
                <div className="rounded-xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                    Income Rule
                  </div>
                  <div className="mt-2 leading-relaxed">{selectedRole.incomeRule}</div>
                </div>

                <div className="rounded-xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                    Visual Reminder
                  </div>
                  <div className="mt-2 leading-relaxed">{selectedRole.graphic}</div>
                </div>

                <div className="rounded-xl border border-[var(--brand-navy)]/10 bg-[var(--brand-ivory)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--brand-navy)]/60">
                    Developer Note
                  </div>
                  <div className="mt-2 leading-relaxed">{selectedRole.developerNotes}</div>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
