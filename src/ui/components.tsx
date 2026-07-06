import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";

const LOGO_LINES = [
  "  ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █░█░█ █ █▄▀ █",
  "  █▀█ █▄█ ██▄ █░▀█ ░█░ ▀▄▀▄▀ █ █░█ █",
];

export function Logo({ subtitle }: { subtitle: string }) {
  const columns = process.stdout.columns ?? 80;
  const showLogo = columns >= 42;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {showLogo ? (
        <Box flexDirection="column">
          {LOGO_LINES.map((line, index) => (
            <Text bold color={index === 0 ? "cyan" : "cyanBright"} key={line}>
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Text bold color="cyan">
          agentwiki
        </Text>
      )}
      <Text>
        <Text color="gray">  v{VERSION} · </Text>
        <Text color="cyan">{subtitle}</Text>
      </Text>
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

  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
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
    return <Text color="green">✔</Text>;
  }
  if (status === "warn") {
    return <Text color="yellow">▲</Text>;
  }
  if (status === "fail") {
    return <Text color="red">✖</Text>;
  }
  return <Text color="gray">○</Text>;
}

export function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderColor="cyan"
      borderStyle="round"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Text>
      <Text color="gray">    ↳ </Text>
      <Text color="yellow">{children}</Text>
    </Text>
  );
}
