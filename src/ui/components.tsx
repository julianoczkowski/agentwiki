import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
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
      <Link
        color={BRAND_DIM}
        label={CHANNEL}
        url="https://www.youtube.com/@aiforwork_app"
      />
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

/** OSC-8 terminal hyperlink — clickable in iTerm2, Ghostty, VS Code, etc. */
export function Link({
  url,
  label,
  color = ACCENT,
}: {
  url: string;
  label?: string;
  color?: string;
}) {
  const osc = "\u001b]8;;";
  const bel = "\u0007";

  return (
    <Text color={color} underline>
      {`${osc}${url}${bel}${label ?? url}${osc}${bel}`}
    </Text>
  );
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
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Flatten fragments so every visual row gets a │ spacer between it and
  // the next, no matter how callers group their JSX.
  const flatten = (nodes: React.ReactNode): React.ReactNode[] =>
    React.Children.toArray(nodes).flatMap((child) =>
      React.isValidElement(child) && child.type === React.Fragment
        ? flatten((child.props as { children?: React.ReactNode }).children)
        : [child],
    );

  const rows = flatten(children).filter(Boolean);

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

/**
 * Two-column row: fixed gutter/glyph column + wrapping content column, so
 * wrapped text stays aligned inside the thread instead of spilling to col 0.
 */
function GutterRow({
  gutter,
  children,
}: {
  gutter: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Box flexShrink={0}>{gutter}</Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
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
    <GutterRow gutter={<Text>{glyph} </Text>}>{children}</GutterRow>
  );
}

/** A plain informational row inside a Section thread. */
export function Line({ children }: { children: React.ReactNode }) {
  return (
    <GutterRow gutter={<Text color={BRAND}>{"│ "}</Text>}>{children}</GutterRow>
  );
}

export interface SelectOption {
  label: string;
  detail?: string;
}

/** Arrow-key select in the create-trimble-app style: ● / ○, Enter confirms. */
export function Select({
  options,
  onSelect,
}: {
  options: SelectOption[];
  onSelect: (index: number) => void;
}) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((current) => (current - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setIndex((current) => (current + 1) % options.length);
    } else if (key.return) {
      onSelect(index);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, optionIndex) => (
        <Text key={option.label}>
          <Text color={optionIndex === index ? "green" : "gray"}>
            {optionIndex === index ? "● " : "○ "}
          </Text>
          <Text bold={optionIndex === index}>{option.label}</Text>
          {option.detail ? <Text color="gray"> ({option.detail})</Text> : null}
        </Text>
      ))}
      <Text>
        <Text color="gray">↑/↓ to navigate · Enter: </Text>
        <Text bold>confirm</Text>
      </Text>
    </Box>
  );
}

/** Indented follow-up under an Item (setup steps, fix hints). */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <GutterRow
      gutter={
        <Text>
          <Text color={BRAND}>{"│ "}</Text>
          <Text color="gray">{"  ↳ "}</Text>
        </Text>
      }
    >
      <Text color="yellow">{children}</Text>
    </GutterRow>
  );
}
