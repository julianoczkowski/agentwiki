import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";

/** Brand palette — matches julianoczkowski/create-trimble-app. */
export const BRAND = "#0063a3";
export const BRAND_DIM = "#5f5f87";
export const ACCENT = "cyan";

/** ANSI-shadow block letters, assembled at load so alignment can't drift. */
const GLYPHS: Record<string, string[]> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  W: ["██╗    ██╗", "██║    ██║", "██║ █╗ ██║", "██║███╗██║", "╚███╔███╔╝", " ╚══╝╚══╝ "],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
};

const LOGO_LINES = [0, 1, 2, 3, 4, 5].map((row) =>
  ["A", "G", "E", "N", "T", "W", "I", "K", "I"]
    .map((letter) => GLYPHS[letter][row])
    .join(""),
);
const LOGO_WIDTH = LOGO_LINES[0].length;

const TAGLINE = "Agent-Maintained Codebase Wiki";
const SUBTITLE = "Deterministic Facts + Agent-Written Prose";
const FEATURES = "Cursor CLI + Claude Code + No API Keys";
const BYLINE = `v${VERSION} by Julian Oczkowski`;
const CHANNEL = "youtube.com/@aiforwork_app";

export function Logo() {
  const columns = process.stdout.columns ?? 80;
  const showBigLogo = columns >= LOGO_WIDTH + 8;

  if (!showBigLogo) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={BRAND}>
          AGENTWIKI
        </Text>
        <Text color="gray">{TAGLINE}</Text>
        <Text color={BRAND_DIM}>
          {BYLINE} · {CHANNEL}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      alignItems="center"
      alignSelf="flex-start"
      borderColor={BRAND}
      borderStyle="double"
      flexDirection="column"
      marginBottom={1}
      paddingX={3}
      paddingY={0}
    >
      <Text> </Text>
      {LOGO_LINES.map((line) => (
        <Text bold color={BRAND} key={line}>
          {line}
        </Text>
      ))}
      <Text> </Text>
      <Text bold color={ACCENT}>
        {TAGLINE}
      </Text>
      <Text color="gray">{SUBTITLE}</Text>
      <Text color="gray">{FEATURES}</Text>
      <Text> </Text>
      <Text color={BRAND_DIM}>{BYLINE}</Text>
      <Text color={BRAND_DIM}>{CHANNEL}</Text>
      <Text> </Text>
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(interval);
    };
  }, []);

  return <Text color={ACCENT}>{SPINNER_FRAMES[frame]}</Text>;
}

export function StatusGlyph({
  status,
}: {
  status: "pending" | "running" | "done" | "warn" | "fail";
}) {
  if (status === "running") {
    return <Spinner />;
  }
  if (status === "done") {
    return <Text color="green">◆</Text>;
  }
  if (status === "warn") {
    return <Text color="yellow">▲</Text>;
  }
  if (status === "fail") {
    return <Text color="red">✖</Text>;
  }
  return <Text color="gray">◇</Text>;
}

/**
 * Clack-style thread: `┌ Title`, gutter `│` lines between rows, `└` close.
 * Rows are Item (glyph row) / Line (plain gutter row) children.
 */
export function Section({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: React.ReactNode;
}) {
  const rows = React.Children.toArray(children).filter(Boolean);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={BRAND}>{"┌ "}</Text>
        <Text bold color={ACCENT}>
          {title}
        </Text>
      </Text>
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          <Text color={BRAND}>│</Text>
          {row}
        </React.Fragment>
      ))}
      <Text color={BRAND}>│</Text>
      <Text>
        <Text color={BRAND}>{"└ "}</Text>
        {footer ? <Text color="gray">{footer}</Text> : null}
      </Text>
    </Box>
  );
}

/** A row with a status/custom glyph, like `◆ Git v2.53.0`. */
export function Item({
  glyph,
  children,
}: {
  glyph: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Text>
      {glyph} {children}
    </Text>
  );
}

/** A plain informational row inside a Section thread. */
export function Line({ children }: { children: React.ReactNode }) {
  return (
    <Text>
      <Text color={BRAND}>{"│ "}</Text>
      {children}
    </Text>
  );
}

/** Indented follow-up under an Item (setup steps, fix hints). */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Text>
      <Text color={BRAND}>{"│ "}</Text>
      <Text color="gray">{"  ↳ "}</Text>
      <Text color="yellow">{children}</Text>
    </Text>
  );
}
