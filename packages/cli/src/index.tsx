import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";

function App() {
  return (
    <box
      alignItems="center"
      justifyContent="center"
      backgroundColor="#0D0D12"
      width="100%"
      height="100%"
    >
      <box
        width={88}
        border={true}
        borderStyle="rounded"
        borderColor="#89B4FA"
        title=" NightCode "
        titleColor="#89B4FA"
        titleAlignment="center"
        shouldFill={false}
        paddingX={3}
        paddingY={2}
        flexDirection="column"
        gap={2}
      >
        <Header />
        <InputBar onSubmit={() => {}} />
      </box>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);