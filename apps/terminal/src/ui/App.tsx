import React from 'react';
import { Box, Text, useInput } from 'ink';

type AppProps = {
  message: string;
  onExit?: () => void;
};

export default function App({ message, onExit }: AppProps) {
  useInput((input) => {
    if (input.toLowerCase() === 'q') {
      onExit?.();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1}>
      <Text color="green">Google Live Agent - Terminal Layer</Text>
      <Text>{message}</Text>
      <Text color="gray">press q to quit</Text>
    </Box>
  );
}
