"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { PRODUCT_NAME } from "@/lib/site-branding";
import { readStartingScenario, startingScenarios, type StartingScenario } from "@/lib/starting-scenario";

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
    advantageRule: "During working-life rounds, draw one Income card each round. After Round 1, keep the higher of your previous primary income and the new card.",
    challengeName: "Career Plateau",
    challengeRule: "A lower Income card does not reduce your income, but it also provides no increase that round.",
    incomeRule: "In Round 1, save your Income card as your primary income. In later working-life rounds, save the card you drew even if it is lower; the game keeps your higher primary income.",
    resultMessage: "You kept climbing. Even when new opportunities offered less income, you maintained the highest income level you had reached.",
    graphic: "Career ladder + upward arrow",
    developerNotes: "Match the card you drew, whether it is W-2 or Business Income. The game keeps the income type of your retained higher-income card.",
  },
  {
    id: "PATH-002",
    name: "Entrepreneur",
    shortDescription: "You pursue additional income by building businesses and taking on new ventures.",
    startingIncomeType: "Any Income Card",
    startingCondition: "Draw one Income card and use its dollar amount as your primary income.",
    advantageName: "Multiple Opportunities",
    advantageRule: "Each working-life round, draw one required Income card. You may then draw one additional card, but keep it only if it is Business Income.",
    challengeName: "More Tax Complexity",
    challengeRule: "The game applies a simplified 9% business-income adjustment, not an additional self-employment tax.",
    incomeRule: "Your required card may be W-2 or Business Income. You may take one optional extra draw. If it is W-2, return it to the bottom of the deck and stop. Do not take a replacement optional draw.",
    resultMessage: "Your willingness to pursue new opportunities gave you additional ways to earn income throughout your financial journey.",
    graphic: "Lightbulb + storefront / laptop",
    developerNotes: "Save your required Income card first. Save the optional card only if it is Business Income, then choose Continue.",
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
    incomeRule: "Keep your permanent dependent throughout the game. Life Events may add or remove other dependents, but you always have at least one.",
    resultMessage: "Caring for another person remained part of your financial life from your working years through retirement.",
    graphic: "Family / caregiver icon",
    developerNotes: "Keep your permanent dependent separate from dependents added by Life Events. Your permanent dependent is never removed.",
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
    developerNotes: "You stay a homeowner until a Life Event changes that. The game compares eligible itemized deductions with the standard deduction; homeownership does not automatically make itemizing better.",
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
    developerNotes: "Record the education-related card you drew. The game checks the current rules to calculate any eligible education benefit.",
  },
  {
    id: "PATH-006",
    name: "Side Hustler",
    shortDescription: "You earn money from multiple sources and those income sources can change throughout your career.",
    startingIncomeType: "Any Income Cards",
    startingCondition: "Draw two Income cards each regular-life round.",
    advantageName: "Two Income Streams",
    advantageRule: "During working-life rounds, draw and save two Income cards, one at a time. Both count, in any combination of W-2 and Business Income.",
    challengeName: "More Income, More Complexity",
    challengeRule: "Both income amounts are included in the player's tax calculation, so multiple income sources create a more complicated tax situation.",
    incomeRule: "Draw and save your first Income card, then draw and save your second. Both count toward your income. Once you are in retirement, follow the Retirement deck instructions instead.",
    resultMessage: "Your income came from multiple sources throughout your career, giving you more income opportunities and more tax situations to manage.",
    graphic: "Briefcase + laptop / two income arrows",
    developerNotes: "Choose Continue only after both required Income cards are saved. You do not choose one card over the other.",
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
    incomeRule: "Draw Income cards normally during working-life rounds. The game includes recurring income from eligible investments automatically.",
    resultMessage: "Starting early gave your investments more opportunities to influence both your annual income and your retirement.",
    graphic: "Investment chart + growing coin/plant",
    developerNotes: "Keep your Starter Investment token. Follow the normal card draws; the game tracks its income and retirement value for you.",
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
    developerNotes: "Use the Income deck in Rounds 1-3 and the Retirement deck in Rounds 4-5. The game calculates your retirement income from the saved card and pathway rules.",
  },
];

const legacyDecisionIds = ["take-opportunity", "play-safe", "adapt-quickly"];
const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

async function loadStartingScenario(player: PlayerSession) {
  const response = await fetch("/api/rounds/one", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: player.id, resumeToken: player.resumeToken }),
  });
  const result = (await response.json()) as {
    initialScenario?: unknown;
    roundNumber?: number;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(result.error ?? "Could not reveal your saved starting scenario. Try again.");
  }
  if (!Number.isInteger(result.roundNumber) || result.roundNumber === undefined ||
    result.roundNumber < 1 || result.roundNumber > 5) {
    throw new Error("The saved round is invalid. Please contact your teacher.");
  }
  return { scenario: readStartingScenario(result.initialScenario), roundNumber: result.roundNumber };
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
      !legacyDecisionIds.includes(result.startingDecisionId)) ||
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
      !legacyDecisionIds.includes(result.startingDecisionId)) ||
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
  const [readyForNextStep, setReadyForNextStep] = useState(false);
  const [startingScenario, setStartingScenario] = useState<StartingScenario | null>(null);
  const [currentRound, setCurrentRound] = useState(1);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const roundEnabled = process.env.NEXT_PUBLIC_ROUND_ONE_ENABLED === "true";
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
          setReadyForNextStep(savedSetup.status === "playing");
          setSetupLoading(false);
        });
        if (savedSetup.status === "playing" && roundEnabled) {
          setSetupSaving(true);
          try {
            const saved = await loadStartingScenario(parsedPlayer);
            if (!cancelled) {
              setStartingScenario(saved.scenario);
              setCurrentRound(saved.roundNumber);
            }
          } catch (error) {
            if (!cancelled) {
              setScenarioError(error instanceof Error ? error.message : "Could not load your starting scenario.");
            }
          } finally {
            if (!cancelled) setSetupSaving(false);
          }
        }
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
  }, [roundEnabled]);

  const selectedRole = rolePathways.find((role) => role.id === selectedRoleId) ?? rolePathways[0];
  function handleReset() {
    window.localStorage.removeItem(PLAYER_STORAGE_KEY);
    router.push("/play");
  }

  function applySavedSetup(setup: SavedSetup) {
    setHasSelectedRole(setup.pathwayId !== null);
    if (setup.pathwayId) {
      setSelectedRoleId(setup.pathwayId);
    }
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
      setReadyForNextStep(false);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not save the selected role.");
    } finally {
      setupActionInProgress.current = false;
      setSetupSaving(false);
    }
  }

  async function revealStartingScenario() {
    if (!hasSelectedRole || !persistenceEnabled || !player || !roundEnabled ||
      startingScenario || setupActionInProgress.current) {
      return;
    }

    setupActionInProgress.current = true;
    setSetupSaving(true);
    setScenarioError(null);
    try {
      if (!readyForNextStep) {
        const savedSetup = await saveSetup(player, {
          pathwayId: selectedRoleId,
          startingDecisionId: null,
          setupComplete: true,
        });
        if (savedSetup.status !== "playing" || savedSetup.pathwayId !== selectedRoleId) {
          throw new Error("Setup completion could not be confirmed as saved.");
        }
        setReadyForNextStep(true);
      }
      const saved = await loadStartingScenario(player);
      setStartingScenario(saved.scenario);
      setCurrentRound(saved.roundNumber);
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : "Could not reveal your starting scenario. Try again.");
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
              {PRODUCT_NAME} · Student Dashboard
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
          <div className="min-w-0 rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-7 shadow-[0_20px_50px_rgba(15,29,82,0.08)]">
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
                  Step 1: Your Pathway / role card
                </p>
                <h3 className="mt-3 text-3xl font-black">Choose the role card you physically drew</h3>
                <p className="mt-4 text-base leading-relaxed text-[var(--brand-navy)]/80">
                  Draw a physical Pathway / role card, then select its matching role below. Reveal your starting scenario to see your starting cash and student debt, then start Round 1.
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
                      <div className="grid gap-4 sm:grid-cols-2">
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
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                        Drawn Role Card
                      </p>
                      <h3 className="mt-2 break-words text-3xl font-black">{selectedRole.name}</h3>
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
                    Step 2: Your starting scenario
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-[var(--brand-navy)]/75">
                    The game assigns and saves your financial starting scenario. Do not draw a physical card or roll for it. Refreshing or trying again keeps the same saved scenario.
                  </p>

                  {scenarioError ? <p role="alert" className="mt-3 text-sm text-red-800">{scenarioError}</p> : null}
                  {!roundEnabled ? <p className="mt-3 text-sm">Starting scenarios and Round 1 are not available yet.</p> : null}
                  {!startingScenario ? (
                    <div className="mt-5">
                      <button
                        type="button"
                        onClick={() => void revealStartingScenario()}
                        disabled={setupSaving || !persistenceEnabled || !roundEnabled}
                        className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
                      >
                        {setupSaving ? "Loading saved scenario..." : "Reveal Starting Scenario"}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-5">
                      <div data-testid="starting-scenario" className="grid gap-4 rounded-2xl border border-[var(--brand-gold)]/40 bg-[var(--brand-gold)]/10 p-4 sm:grid-cols-2">
                        <div className="min-w-0">
                          <h4 className="text-xl font-black">{startingScenarios[startingScenario.scenarioId].name}</h4>
                          <p className="mt-2 text-sm leading-relaxed">{startingScenarios[startingScenario.scenarioId].description}</p>
                        </div>
                        <dl className="space-y-2 text-sm">
                          <div><dt className="font-bold">Starting Cash</dt><dd>{money(startingScenario.startingCash)}</dd></div>
                          <div><dt className="font-bold">Student Debt</dt><dd>{money(startingScenario.startingStudentLoanDebt)}</dd></div>
                        </dl>
                      </div>
                      <Link
                        href="/play/round-1"
                        className="mt-4 inline-flex rounded-xl bg-[var(--brand-navy)] px-6 py-3 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
                      >
                        {currentRound === 1 ? "Start Round 1" : `Resume Round ${currentRound}`}
                      </Link>
                    </div>
                  )}

                </div>
              </div>
            )}
          </div>

          <aside className="min-w-0 space-y-6">
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
                    Play reminder
                  </div>
                  <div className="mt-2 leading-relaxed">{selectedRole.developerNotes}</div>
                  <p className="mt-2 leading-relaxed">
                    The app records your physical gameplay draws; it does not randomly choose those cards.
                    Draw from the physical deck shown, select the matching card on screen, and choose Save This Card.
                    Save all required cards before choosing Continue. After Deduction, choose Calculate My Taxes,
                    then Continue to Tax Prepayment and draw and save that physical card.
                    Complete any keep-or-redraw choice shown, continue to Results, and choose Finish Round.
                    Start the next round from saved Results when available.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
