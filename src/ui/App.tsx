import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { WIKI_DIR } from "../constants.js";
import {
  detectBackends,
  setupSteps,
  type DetectedBackend,
} from "../backends/index.js";
import type { BackendId } from "../backends/types.js";
import { HELP_EXAMPLES, HELP_GROUPS, HELP_INTRO } from "../commands.js";
import { patchMeta, readMeta, saveBackendPreference } from "../engine/wiki.js";
import { matchAppForPath, type WorkspaceApp } from "../engine/workspaces.js";
import {
  gatherStatus,
  runDoctor,
  runGenerate,
  GENERATE_PHASES,
  type DoctorCheck,
  type GenerateSummary,
  type PhaseStatus,
  type StatusReport,
} from "../runner.js";
import {
  ACCENT,
  BRAND_DIM,
  Hint,
  Item,
  Line,
  Link,
  Logo,
  Section,
  Select,
  StatusGlyph,
} from "./components.js";

type GenerateMode = "init" | "update";

function backendReadiness(candidate: DetectedBackend): string {
  if (!candidate.status.installed) {
    return "not installed — we'll show the install steps after setup";
  }
  if (candidate.status.auth === "missing") {
    return "installed, sign-in needed — we'll show the steps after setup";
  }
  return "ready to write prose";
}

/** First step of init: pick which coding agent writes the prose. */
function BackendPicker({
  backends,
  onDone,
  root,
}: {
  backends: DetectedBackend[];
  onDone: () => void;
  root: string;
}) {
  const options = [
    ...backends.map((candidate) => ({
      label: candidate.backend.label,
      detail: backendReadiness(candidate),
    })),
    {
      label: "Decide later",
      detail: "agentwiki will use whichever agent is ready",
    },
  ];

  return (
    <Section
      title="Choose Your Prose Writer"
      footer="saved per project — change any time with agentwiki backend <cursor|claude>"
    >
      <Line>
        agentwiki never calls an LLM itself. Which coding agent should write
      </Line>
      <Line>
        the wiki's prose sections, on your existing subscription?
      </Line>
      <Select
        options={options}
        onSelect={(index) => {
          const picked = backends[index];
          if (picked) {
            void saveBackendPreference(root, picked.backend.id).then(onDone);
          } else {
            onDone();
          }
        }}
      />
    </Section>
  );
}

/**
 * Monorepo-only first step of init: pick which app the wiki documents.
 * Applications are shown first; shared packages/libraries stay behind a
 * "Something else…" expander so a 2-app repo shows exactly 2 apps. The
 * answer is saved to the wiki metadata; update/hooks never re-ask.
 */
function ScopePicker({
  apps,
  invokedFrom = "",
  onDone,
  root,
}: {
  apps: WorkspaceApp[];
  invokedFrom?: string;
  onDone: () => void;
  root: string;
}) {
  // Standing inside an app when running init is a strong hint — pre-select it.
  const suggested = matchAppForPath(apps, invokedFrom);
  // Standing in a folder detection did NOT recognize is a stronger hint
  // still: offer it directly, so no app can ever be out of reach.
  const hereDir = invokedFrom && !suggested ? invokedFrom : null;
  const [showAll, setShowAll] = useState(suggested?.kind === "package");
  const applications = apps.filter((app) => app.kind === "app");
  const packages = apps.filter((app) => app.kind === "package");
  // No recognizable apps (or user expanded): offer every workspace member.
  const listed =
    showAll || applications.length === 0 ? [...applications, ...packages] : applications;
  const expandable = !showAll && applications.length > 0 && packages.length > 0;
  const listedOffset = hereDir ? 2 : 1;
  const suggestedIndex = suggested ? listed.indexOf(suggested) : -1;

  const options = [
    {
      label: "The whole repository",
      detail: "one wiki covering everything at once",
    },
    ...(hereDir
      ? [
          {
            label: `This folder: ${hereDir}/`,
            detail: "where you ran init from",
          },
        ]
      : []),
    ...listed.map((app) => ({
      label: `${app.dir}/`,
      detail: `${
        app.kind === "package"
          ? `${app.name ?? "detected"} — shared package`
          : app.name ?? "detected app"
      }${app === suggested ? " — you ran init from here" : ""}`,
    })),
    ...(expandable
      ? [
          {
            label: "Something else…",
            detail: `show ${packages.length} shared package${packages.length === 1 ? "" : "s"}/libraries too`,
          },
        ]
      : []),
  ];

  return (
    <Section
      title="Which App Should the Wiki Document?"
      footer="saved per project — change later with agentwiki init --scope <dir>"
    >
      <Line>
        This looks like a monorepo
        {applications.length > 0
          ? ` with ${applications.length} app${applications.length === 1 ? "" : "s"}`
          : ` with ${apps.length} workspace members`}
        . AgentWiki can document
      </Line>
      <Line>
        one of them in depth, or the whole repository at once.
      </Line>
      <Select
        initialIndex={
          hereDir ? 1 : suggestedIndex >= 0 ? suggestedIndex + listedOffset : 0
        }
        options={options}
        onSelect={(index) => {
          if (expandable && index === options.length - 1) {
            setShowAll(true);
            return;
          }
          // "" records "whole repository" as an explicit answer so the
          // question is never asked again for this project.
          const scope =
            hereDir && index === 1
              ? hereDir
              : (listed[index - listedOffset]?.dir ?? "");
          void patchMeta(root, { scope }).then(onDone);
        }}
      />
    </Section>
  );
}

/** The backend enrich would use right now, honoring a saved preference. */
function readyBackendFor(summary: GenerateSummary): DetectedBackend | null {
  const relevant = summary.preferredBackend
    ? summary.backends.filter(
        (candidate) => candidate.backend.id === summary.preferredBackend,
      )
    : summary.backends;

  return (
    relevant.find(
      (candidate) =>
        candidate.status.installed && candidate.status.auth !== "missing",
    ) ?? null
  );
}

export function GenerateApp({
  mode,
  root,
  askBackend = false,
  invokedFrom = "",
  scopeApps = [],
  onEnrichChosen,
}: {
  mode: GenerateMode;
  root: string;
  askBackend?: boolean;
  invokedFrom?: string;
  scopeApps?: WorkspaceApp[];
  onEnrichChosen?: () => void;
}) {
  const app = useApp();
  const startedRef = useRef(false);
  const [stage, setStage] = useState<"scope" | "pick" | "run">(
    scopeApps.length > 0 ? "scope" : askBackend ? "pick" : "run",
  );
  const [detected, setDetected] = useState<DetectedBackend[] | null>(null);
  const [phases, setPhases] = useState(
    GENERATE_PHASES.map((phase) => ({
      ...phase,
      status: "pending" as PhaseStatus,
      detail: "",
    })),
  );
  const [summary, setSummary] = useState<GenerateSummary | null>(null);
  const [offerProse, setOfferProse] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== "pick" || detected !== null) {
      return;
    }
    detectBackends().then(setDetected);
  }, [stage, detected]);

  useEffect(() => {
    if (stage !== "run" || startedRef.current) {
      return;
    }
    startedRef.current = true;

    runGenerate(root, mode, (event) => {
      setPhases((current) =>
        current.map((phase) =>
          phase.id === event.id
            ? { ...phase, status: event.status, detail: event.detail ?? phase.detail }
            : phase,
        ),
      );
    })
      .then((result) => {
        setSummary(result);

        // Close the loop for users who would never run a second command:
        // when an agent is ready and prose is pending, offer to write it now.
        const pending =
          result.write.slotCounts.empty + result.write.slotCounts.stale;
        if (
          mode === "init" &&
          Boolean(process.stdin.isTTY) &&
          pending > 0 &&
          readyBackendFor(result) !== null &&
          onEnrichChosen
        ) {
          setOfferProse(true);
          return;
        }

        process.exitCode = 0;
        app.exit();
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        process.exitCode = 1;
        app.exit();
      });
  }, [app, mode, onEnrichChosen, root, stage]);

  const running = summary === null && error === null;

  if (stage === "scope") {
    return (
      <Box flexDirection="column">
        <Logo />
        <ScopePicker
          apps={scopeApps}
          invokedFrom={invokedFrom}
          onDone={() => setStage(askBackend ? "pick" : "run")}
          root={root}
        />
      </Box>
    );
  }

  if (stage === "pick") {
    return (
      <Box flexDirection="column">
        <Logo />
        {detected === null ? (
          <Section title="Choose Your Prose Writer" footer="checking…">
            <Line>
              <Text color="white">Checking which coding agents you have…</Text>
            </Line>
          </Section>
        ) : (
          <BackendPicker
            backends={detected}
            onDone={() => setStage("run")}
            root={root}
          />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Logo />
      <Section
        title={mode === "init" ? "Wiki Setup" : "Wiki Update"}
        footer={
          running
            ? "working…"
            : error
              ? "failed"
              : `done — ${WIKI_DIR}/quickstart.md`
        }
      >
        {invokedFrom ? (
          <Line>
            <Text color="white">
              running from <Text bold>{invokedFrom}/</Text> — everything is
              created at the repo root
            </Text>
          </Line>
        ) : null}
        {phases.map((phase) => (
          <Item glyph={<StatusGlyph status={phase.status} />} key={phase.id}>
            <Text bold={phase.status === "running"}>{phase.title}</Text>
            {phase.detail ? <Text color="white">  {phase.detail}</Text> : null}
          </Item>
        ))}
      </Section>
      {error ? (
        <Text>
          <Text color="red">✖ </Text>
          <Text color="red">{error}</Text>
        </Text>
      ) : null}
      {summary ? (
        <GenerateSummaryView hideNextStep={offerProse} summary={summary} />
      ) : null}
      {summary && offerProse ? (
        <Section
          title="Write the Prose Now?"
          footer="uses your existing subscription — agentwiki itself never calls an LLM"
        >
          <Line>
            {summary.write.slotCounts.empty + summary.write.slotCounts.stale}{" "}
            sections are waiting for prose. Your{" "}
            {readyBackendFor(summary)?.backend.label} is ready and can write
            them right now (takes a few minutes).
          </Line>
          <Select
            options={[
              {
                label: "Yes, write the prose now",
                detail: "recommended — finishes your wiki in one go",
              },
              {
                label: "Skip for now",
                detail: "run `agentwiki enrich` later, or let Cursor fill it as you work",
              },
            ]}
            onSelect={(index) => {
              if (index === 0) {
                onEnrichChosen?.();
              }
              process.exitCode = 0;
              app.exit();
            }}
          />
        </Section>
      ) : null}
    </Box>
  );
}

function GenerateSummaryView({
  summary,
  hideNextStep = false,
}: {
  summary: GenerateSummary;
  hideNextStep?: boolean;
}) {
  const { write, backends } = summary;
  const created = write.pages.filter((page) => page.action === "created").length;
  const updated = write.pages.filter((page) => page.action === "updated").length;
  const removed = write.pages.filter((page) => page.action === "removed").length;
  const pending = write.slotCounts.empty + write.slotCounts.stale;
  // A chosen backend is authoritative: only talk about that one.
  const relevant = summary.preferredBackend
    ? backends.filter(
        (candidate) => candidate.backend.id === summary.preferredBackend,
      )
    : backends;
  const usable = relevant.filter(
    (candidate) => candidate.status.installed && candidate.status.auth !== "missing",
  );
  const notReady = relevant.filter(
    (candidate) => !candidate.status.installed || candidate.status.auth === "missing",
  );

  return (
    <Box flexDirection="column">
      <Section
        title={summary.mode === "init" ? "Wiki Initialized" : "Wiki Updated"}
        footer={
          write.contentChanged
            ? `${WIKI_DIR}/ is up to date`
            : "no content changes — metadata left untouched"
        }
      >
        <Item glyph={<StatusGlyph status="done" />}>
          {created} pages created, {updated} updated, {removed} removed{" "}
          <Text color="white">
            ({summary.totalFiles} files scanned
            {summary.scope ? ` in ${summary.scope}/` : ""}, {summary.modules}{" "}
            modules)
          </Text>
        </Item>
        <Item
          glyph={
            <StatusGlyph status={pending > 0 ? "warn" : "done"} />
          }
        >
          Prose slots: <Text color="green">{write.slotCounts.fresh} fresh</Text>
          <Text color="white"> · </Text>
          <Text color="yellow">{write.slotCounts.stale} stale</Text>
          <Text color="white"> · </Text>
          <Text color="white">{write.slotCounts.empty} empty</Text>
        </Item>
        {!summary.workflowPresent ? (
          <Item glyph={<StatusGlyph status="pending" />}>
            <Text color="white">
              CI not wired — run <Text color={ACCENT}>agentwiki setup-action</Text>{" "}
              to re-add the GitHub workflow
            </Text>
          </Item>
        ) : null}
      </Section>

      {pending > 0 && !hideNextStep ? (
        <Section
          title="Next Step: Write the Prose"
          footer="agentwiki never calls an LLM itself — your agent, your subscription"
        >
          {usable.length > 0 && summary.preferredBackend ? (
            <>
              <Line>
                {pending} section{pending === 1 ? "" : "s"} need prose. Your{" "}
                {usable.map((candidate) => candidate.backend.label).join(" or ")}{" "}
                can write them now:
              </Line>
              <Item glyph={<Text color={ACCENT}>❯</Text>}>
                <Text bold color={ACCENT}>
                  agentwiki enrich
                </Text>
              </Item>
            </>
          ) : usable.length > 0 ? (
            <>
              <Line>
                {pending} section{pending === 1 ? "" : "s"} need prose. You
                haven't picked a preferred agent yet — here's what you have:
              </Line>
              {relevant.map(({ backend, status }) => (
                <Item
                  glyph={
                    <StatusGlyph
                      status={
                        status.installed && status.auth !== "missing"
                          ? "done"
                          : "warn"
                      }
                    />
                  }
                  key={backend.id}
                >
                  <Text bold>{backend.label.padEnd(12)}</Text>
                  <Text color="white">
                    {status.installed
                      ? status.auth !== "missing"
                        ? "ready to write prose"
                        : status.authDetail
                      : "not installed"}
                  </Text>
                </Item>
              ))}
              <Item glyph={<Text color={ACCENT}>❯</Text>}>
                <Text bold color={ACCENT}>
                  agentwiki backend
                </Text>
                <Text color="white">  — pick your preferred agent first</Text>
              </Item>
              <Item glyph={<Text color={ACCENT}>❯</Text>}>
                <Text bold color={ACCENT}>
                  agentwiki enrich
                </Text>
                <Text color="white">
                  {"  "}— or write now with whichever agent is ready
                </Text>
              </Item>
            </>
          ) : (
            <>
              {summary.preferredBackend ? (
                <Line>
                  {pending} section{pending === 1 ? "" : "s"} need prose. Your
                  chosen agent isn't ready yet — follow these steps:
                </Line>
              ) : (
                <>
                  <Line>
                    {pending} section{pending === 1 ? "" : "s"} need prose, but
                    no coding agent is ready yet. Pick ONE (Cursor if you use
                  </Line>
                  <Line>
                    the Cursor editor, Claude Code if you have a Claude
                    subscription) and follow its steps in this terminal:
                  </Line>
                </>
              )}
              {notReady.map(({ backend, status }) => (
                <Box flexDirection="column" key={backend.id}>
                  <Item
                    glyph={
                      <StatusGlyph
                        status={status.installed ? "warn" : "pending"}
                      />
                    }
                  >
                    <Text bold>{backend.label}</Text>{" "}
                    <Text color={status.installed ? "yellow" : "white"}>
                      {status.installed ? status.authDetail : "not installed"}
                    </Text>
                  </Item>
                  {setupSteps(backend, status).map((step, index) => (
                    <Line key={`${backend.id}-${index}`}>
                      <Text color="white">  {index + 1}. </Text>
                      {step.run ? (
                        <>
                          <Text color={ACCENT}>{step.run}</Text>
                          <Text color="white">  — {step.note}</Text>
                        </>
                      ) : (
                        <Text color="white">{step.note}</Text>
                      )}
                    </Line>
                  ))}
                </Box>
              ))}
              <Line>
                <Text color="white">
                  When the steps are done, run:{" "}
                  <Text color={ACCENT}>agentwiki enrich</Text>
                </Text>
              </Line>
            </>
          )}
        </Section>
      ) : null}
    </Box>
  );
}

/** `agentwiki backend` with no args: interactive re-pick of the prose writer. */
export function BackendApp({ root }: { root: string }) {
  const app = useApp();
  const [detected, setDetected] = useState<DetectedBackend[] | null>(null);
  const [current, setCurrent] = useState<BackendId | null>(null);
  const [chosen, setChosen] = useState<DetectedBackend | null>(null);

  useEffect(() => {
    Promise.all([detectBackends(), readMeta(root)]).then(([backends, meta]) => {
      setDetected(backends);
      setCurrent(meta?.backend ?? null);
    });
  }, [root]);

  useEffect(() => {
    if (chosen === null) {
      return;
    }
    saveBackendPreference(root, chosen.backend.id).then(() => {
      process.exitCode = 0;
      app.exit();
    });
  }, [app, chosen, root]);

  if (chosen !== null) {
    const steps = setupSteps(chosen.backend, chosen.status);

    return (
      <Box flexDirection="column">
        <Logo />
        <Section
          title="Prose Writer"
          footer={
            steps.length > 0
              ? "finish the steps above, then run agentwiki enrich"
              : "run agentwiki enrich any time"
          }
        >
          <Item glyph={<StatusGlyph status="done" />}>
            Preferred backend saved:{" "}
            <Text bold color={ACCENT}>
              {chosen.backend.label}
            </Text>
          </Item>
          {steps.map((step, index) => (
            <Line key={index}>
              <Text color="white">  {index + 1}. </Text>
              {step.run ? (
                <>
                  <Text color={ACCENT}>{step.run}</Text>
                  <Text color="white">  — {step.note}</Text>
                </>
              ) : (
                <Text color="white">{step.note}</Text>
              )}
            </Line>
          ))}
        </Section>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Logo />
      {detected === null ? (
        <Section title="Choose Your Prose Writer" footer="checking…">
          <Line>
            <Text color="white">Checking which coding agents you have…</Text>
          </Line>
        </Section>
      ) : (
        <Section
          title="Choose Your Prose Writer"
          footer="saved per project — this replaces the current choice"
        >
          <Line>
            Which coding agent should write this project's wiki prose?
          </Line>
          <Select
            options={detected.map((candidate) => ({
              label:
                candidate.backend.id === current
                  ? `${candidate.backend.label} — current`
                  : candidate.backend.label,
              detail: backendReadiness(candidate),
            }))}
            onSelect={(index) => {
              setChosen(detected[index]);
            }}
          />
        </Section>
      )}
    </Box>
  );
}

/** Visual help screen: hero + grouped command reference. */
export function HelpApp() {
  return (
    <Box flexDirection="column">
      <Logo />
      <Section
        title="What It Does"
        footer={
          <Text color="white">
            docs:{" "}
            <Link
              color="white"
              label="github.com/julianoczkowski/agentwiki"
              url="https://github.com/julianoczkowski/agentwiki"
            />
          </Text>
        }
      >
        <Line>
          <Text color="white">{HELP_INTRO}</Text>
        </Line>
      </Section>
      {HELP_GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <Item
              glyph={<Text color={BRAND_DIM}>❯</Text>}
              key={row.command}
            >
              <Text bold color={ACCENT}>
                {row.command.padEnd(30)}
              </Text>
              <Text color="white">{row.description}</Text>
            </Item>
          ))}
        </Section>
      ))}
      <Section title="Examples">
        {HELP_EXAMPLES.map((example) => (
          <Item glyph={<Text color="green">$</Text>} key={example}>
            <Text color={ACCENT}>{example}</Text>
          </Item>
        ))}
      </Section>
    </Box>
  );
}

export function DoctorApp({ root }: { root: string }) {
  const app = useApp();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);

  useEffect(() => {
    runDoctor(root).then((results) => {
      setChecks(results);
      process.exitCode = results.some((check) => check.status === "fail") ? 1 : 0;
      app.exit();
    });
  }, [app, root]);

  return (
    <Box flexDirection="column">
      <Logo />
      <Section
        title="Environment Check"
        footer={
          checks === null
            ? "checking…"
            : checks.some((check) => check.status !== "ok")
              ? "follow the steps above, then run agentwiki doctor again"
              : "everything is ready"
        }
      >
        {checks === null ? (
          <Line>
            <Text color="white">Checking development environment…</Text>
          </Line>
        ) : (
          checks.map((check) => (
            <Box flexDirection="column" key={check.label}>
              <Item
                glyph={
                  <StatusGlyph
                    status={
                      check.status === "ok"
                        ? "done"
                        : check.status === "warn"
                          ? "warn"
                          : "fail"
                    }
                  />
                }
              >
                <Text bold>{check.label.padEnd(16)}</Text>
                <Text color="white">{check.detail}</Text>
              </Item>
              {check.hints?.map((hint) => <Hint key={hint}>{hint}</Hint>)}
            </Box>
          ))
        )}
      </Section>
    </Box>
  );
}

export function StatusApp({ root }: { root: string }) {
  const app = useApp();
  const [report, setReport] = useState<StatusReport | null>(null);

  useEffect(() => {
    gatherStatus(root).then((result) => {
      setReport(result);
      process.exitCode = 0;
      app.exit();
    });
  }, [app, root]);

  if (report === null) {
    return (
      <Box flexDirection="column">
        <Logo />
        <Text color="white">Reading wiki…</Text>
      </Box>
    );
  }

  if (!report.initialized) {
    return (
      <Box flexDirection="column">
        <Logo />
        <Section title="Wiki Status" footer="nothing here yet">
          <Item glyph={<StatusGlyph status="warn" />}>
            No wiki found. Run{" "}
            <Text bold color={ACCENT}>
              agentwiki init
            </Text>{" "}
            to create one.
          </Item>
        </Section>
      </Box>
    );
  }

  const counts = { fresh: 0, stale: 0, empty: 0 };
  for (const page of report.pages) {
    for (const slot of page.slots) {
      counts[slot.status] += 1;
    }
  }
  const pending = counts.stale + counts.empty;

  return (
    <Box flexDirection="column">
      <Logo />
      <Section
        title="Wiki Status"
        footer={
          pending > 0
            ? `${pending} slots need prose — run agentwiki enrich`
            : "wiki is fully fresh"
        }
      >
        <Item glyph={<StatusGlyph status={pending > 0 ? "warn" : "done"} />}>
          {report.pages.length} pages ·{" "}
          <Text color="green">{counts.fresh} fresh</Text> ·{" "}
          <Text color="yellow">{counts.stale} stale</Text> ·{" "}
          <Text color="white">{counts.empty} empty</Text>
        </Item>
        {report.meta ? (
          <Line>
            <Text color={BRAND_DIM}>
              last {report.meta.command} {report.meta.updatedAt}
              {report.meta.gitHead ? ` at ${report.meta.gitHead}` : ""}
              {report.meta.backend ? ` · backend: ${report.meta.backend}` : ""}
              {report.meta.scope ? ` · scope: ${report.meta.scope}/` : ""}
            </Text>
          </Line>
        ) : null}
        {report.meta?.paused ? (
          <Item glyph={<StatusGlyph status="warn" />}>
            <Text color="yellow">
              paused — updates are no-ops, run `agentwiki resume` to re-enable
            </Text>
          </Item>
        ) : null}
        <Box flexDirection="column">
          {report.pages.map((page) => (
            <Line key={page.file}>
              <Text color="white">{page.file.padEnd(36)}</Text>
              {page.slots.map((slot, index) => (
                <Text key={`${page.file}-${slot.slot}`}>
                  {index > 0 ? <Text color="white"> · </Text> : null}
                  <Text
                    color={
                      slot.status === "fresh"
                        ? "green"
                        : slot.status === "stale"
                          ? "yellow"
                          : "white"
                    }
                  >
                    {slot.slot}
                  </Text>
                </Text>
              ))}
            </Line>
          ))}
        </Box>
      </Section>
    </Box>
  );
}
