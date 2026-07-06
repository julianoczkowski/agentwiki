import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { WIKI_DIR } from "../constants.js";
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
import { Hint, Logo, Panel, StatusGlyph } from "./components.js";

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

  return (
    <Box flexDirection="column">
      <Logo subtitle={mode === "init" ? "initializing wiki" : "updating wiki"} />
      <Box flexDirection="column" marginBottom={1}>
        {phases.map((phase) => (
          <Text key={phase.id}>
            {"  "}
            <StatusGlyph status={phase.status} />{" "}
            <Text bold={phase.status === "running"}>{phase.title}</Text>
            {phase.detail ? <Text color="gray">  {phase.detail}</Text> : null}
          </Text>
        ))}
      </Box>
      {error ? <Text color="red">✖ {error}</Text> : null}
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
  const uninstalled = backends.filter((candidate) => !candidate.status.installed);
  const loggedOut = backends.filter(
    (candidate) => candidate.status.installed && candidate.status.auth === "missing",
  );

  return (
    <Box flexDirection="column">
      <Panel title={summary.mode === "init" ? "Wiki initialized" : "Wiki updated"}>
        <Text>
          {WIKI_DIR}/ — {created} pages created, {updated} updated, {removed}{" "}
          removed{" "}
          <Text color="gray">
            ({summary.totalFiles} files scanned, {summary.modules} modules)
          </Text>
        </Text>
        <Text>
          Prose slots: <Text color="green">{write.slotCounts.fresh} fresh</Text>
          {" · "}
          <Text color="yellow">{write.slotCounts.stale} stale</Text>
          {" · "}
          <Text color="gray">{write.slotCounts.empty} empty</Text>
        </Text>
        {!write.contentChanged ? (
          <Text color="gray">No content changes — metadata left untouched.</Text>
        ) : null}
      </Panel>

      {pending > 0 ? (
        <Panel title="Next step: write the prose">
          {usable.length > 0 ? (
            <>
              <Text>
                {pending} section{pending === 1 ? "" : "s"} need prose. Your{" "}
                {usable.map((candidate) => candidate.backend.label).join(" or ")}{" "}
                can write them on your existing subscription:
              </Text>
              <Text bold color="cyan">
                {"  "}agentwiki enrich
              </Text>
            </>
          ) : (
            <>
              <Text>
                {pending} section{pending === 1 ? "" : "s"} need prose. agentwiki
                doesn't call any LLM itself — it borrows the coding agent you
                already have. None is ready yet:
              </Text>
              {uninstalled.map(({ backend }) => (
                <Box flexDirection="column" key={backend.id} marginTop={1}>
                  <Text>
                    <Text bold>{backend.label}</Text>{" "}
                    <Text color="gray">not installed — install with:</Text>
                  </Text>
                  <Text color="cyan">{"    "}{backend.installHint}</Text>
                </Box>
              ))}
              {loggedOut.map(({ backend, status }) => (
                <Box flexDirection="column" key={backend.id} marginTop={1}>
                  <Text>
                    <Text bold>{backend.label}</Text>{" "}
                    <Text color="yellow">{status.authDetail}</Text>
                  </Text>
                  <Text color="cyan">{"    "}{backend.loginHint}</Text>
                </Box>
              ))}
              <Text color="gray">
                Then run: agentwiki enrich   (or fill slots from inside your
                editor — see agentwiki queue)
              </Text>
            </>
          )}
        </Panel>
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
      <Logo subtitle="environment check" />
      {checks === null ? (
        <Text color="gray">Checking…</Text>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {checks.map((check) => (
            <Box flexDirection="column" key={check.label}>
              <Text>
                {"  "}
                <StatusGlyph
                  status={
                    check.status === "ok"
                      ? "done"
                      : check.status === "warn"
                        ? "warn"
                        : "fail"
                  }
                />{" "}
                <Text bold>{check.label.padEnd(16)}</Text>
                <Text color="gray">{check.detail}</Text>
              </Text>
              {check.hint ? <Hint>{check.hint}</Hint> : null}
            </Box>
          ))}
        </Box>
      )}
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
        <Logo subtitle="status" />
        <Text color="gray">Reading wiki…</Text>
      </Box>
    );
  }

  if (!report.initialized) {
    return (
      <Box flexDirection="column">
        <Logo subtitle="status" />
        <Text>
          <Text color="yellow">▲ </Text>No wiki found. Run{" "}
          <Text bold color="cyan">
            agentwiki init
          </Text>{" "}
          to create one.
        </Text>
      </Box>
    );
  }

  const counts = { fresh: 0, stale: 0, empty: 0 };
  for (const page of report.pages) {
    for (const slot of page.slots) {
      counts[slot.status] += 1;
    }
  }

  return (
    <Box flexDirection="column">
      <Logo subtitle="status" />
      <Panel title="Wiki">
        <Text>
          {report.pages.length} pages ·{" "}
          <Text color="green">{counts.fresh} fresh</Text> ·{" "}
          <Text color="yellow">{counts.stale} stale</Text> ·{" "}
          <Text color="gray">{counts.empty} empty</Text>
        </Text>
        {report.meta ? (
          <Text color="gray">
            last {report.meta.command} {report.meta.updatedAt}
            {report.meta.gitHead ? ` at ${report.meta.gitHead}` : ""}
            {report.meta.backend ? ` · backend: ${report.meta.backend}` : ""}
          </Text>
        ) : null}
        {report.meta?.paused ? (
          <Text color="yellow">
            ⏸ paused — updates are no-ops, run `agentwiki resume` to re-enable
          </Text>
        ) : null}
      </Panel>
      <Box flexDirection="column" marginBottom={1}>
        {report.pages.map((page) => (
          <Text key={page.file}>
            {"  "}
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
          </Text>
        ))}
      </Box>
      {counts.stale + counts.empty > 0 ? (
        <Text>
          <Text color="yellow">▲ </Text>
          {counts.stale + counts.empty} slots need prose — run{" "}
          <Text bold color="cyan">
            agentwiki enrich
          </Text>
        </Text>
      ) : (
        <Text>
          <Text color="green">✔ </Text>Wiki is fully fresh.
        </Text>
      )}
    </Box>
  );
}
