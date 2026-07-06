import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { WIKI_DIR } from "../constants.js";
import { setupSteps } from "../backends/index.js";
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
  Logo,
  Section,
  StatusGlyph,
} from "./components.js";

type GenerateMode = "init" | "update";

export function GenerateApp({ mode, root }: { mode: GenerateMode; root: string }) {
  const app = useApp();
  const startedRef = useRef(false);
  const [phases, setPhases] = useState(
    GENERATE_PHASES.map((phase) => ({
      ...phase,
      status: "pending" as PhaseStatus,
      detail: "",
    })),
  );
  const [summary, setSummary] = useState<GenerateSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) {
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
        process.exitCode = 0;
        app.exit();
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        process.exitCode = 1;
        app.exit();
      });
  }, [app, mode, root]);

  const running = summary === null && error === null;

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
        {phases.map((phase) => (
          <Item glyph={<StatusGlyph status={phase.status} />} key={phase.id}>
            <Text bold={phase.status === "running"}>{phase.title}</Text>
            {phase.detail ? <Text color="gray">  {phase.detail}</Text> : null}
          </Item>
        ))}
      </Section>
      {error ? (
        <Text>
          <Text color="red">✖ </Text>
          <Text color="red">{error}</Text>
        </Text>
      ) : null}
      {summary ? <GenerateSummaryView summary={summary} /> : null}
    </Box>
  );
}

function GenerateSummaryView({ summary }: { summary: GenerateSummary }) {
  const { write, backends } = summary;
  const created = write.pages.filter((page) => page.action === "created").length;
  const updated = write.pages.filter((page) => page.action === "updated").length;
  const removed = write.pages.filter((page) => page.action === "removed").length;
  const pending = write.slotCounts.empty + write.slotCounts.stale;
  const usable = backends.filter(
    (candidate) => candidate.status.installed && candidate.status.auth !== "missing",
  );
  const notReady = backends.filter(
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
          <Text color="gray">
            ({summary.totalFiles} files scanned, {summary.modules} modules)
          </Text>
        </Item>
        <Item
          glyph={
            <StatusGlyph status={pending > 0 ? "warn" : "done"} />
          }
        >
          Prose slots: <Text color="green">{write.slotCounts.fresh} fresh</Text>
          <Text color="gray"> · </Text>
          <Text color="yellow">{write.slotCounts.stale} stale</Text>
          <Text color="gray"> · </Text>
          <Text color="gray">{write.slotCounts.empty} empty</Text>
        </Item>
        {!summary.workflowPresent ? (
          <Item glyph={<StatusGlyph status="pending" />}>
            <Text color="gray">
              CI not wired — run <Text color={ACCENT}>agentwiki setup-action</Text>{" "}
              to re-add the GitHub workflow
            </Text>
          </Item>
        ) : null}
      </Section>

      {pending > 0 ? (
        <Section
          title="Next Step: Write the Prose"
          footer="agentwiki never calls an LLM itself — your agent, your subscription"
        >
          {usable.length > 0 ? (
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
          ) : (
            <>
              <Line>
                {pending} section{pending === 1 ? "" : "s"} need prose, but no
                coding agent is ready yet. Pick ONE (Cursor if you use the
              </Line>
              <Line>
                Cursor editor, Claude Code if you have a Claude subscription)
                and follow its steps in this terminal:
              </Line>
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
                    <Text color={status.installed ? "yellow" : "gray"}>
                      {status.installed ? status.authDetail : "not installed"}
                    </Text>
                  </Item>
                  {setupSteps(backend, status).map((step, index) => (
                    <Line key={`${backend.id}-${index}`}>
                      <Text color="gray">  {index + 1}. </Text>
                      {step.run ? (
                        <>
                          <Text color={ACCENT}>{step.run}</Text>
                          <Text color="gray">  — {step.note}</Text>
                        </>
                      ) : (
                        <Text color="gray">{step.note}</Text>
                      )}
                    </Line>
                  ))}
                </Box>
              ))}
              <Line>
                <Text color="gray">
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
            <Text color="gray">Checking development environment…</Text>
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
                <Text color="gray">{check.detail}</Text>
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
        <Text color="gray">Reading wiki…</Text>
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
          <Text color="gray">{counts.empty} empty</Text>
        </Item>
        {report.meta ? (
          <Line>
            <Text color={BRAND_DIM}>
              last {report.meta.command} {report.meta.updatedAt}
              {report.meta.gitHead ? ` at ${report.meta.gitHead}` : ""}
              {report.meta.backend ? ` · backend: ${report.meta.backend}` : ""}
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
              <Text color="gray">{page.file.padEnd(36)}</Text>
              {page.slots.map((slot, index) => (
                <Text key={`${page.file}-${slot.slot}`}>
                  {index > 0 ? <Text color="gray"> · </Text> : null}
                  <Text
                    color={
                      slot.status === "fresh"
                        ? "green"
                        : slot.status === "stale"
                          ? "yellow"
                          : "gray"
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
