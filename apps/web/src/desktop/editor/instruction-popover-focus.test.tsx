import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ToolcraftPopover } from "@reelterminal/ui/components/toolcraft-popover";

// Keep Radix's deferred close-focus contract, without JSDOM's popper layout
// loop. The real Radix scheduling is also exercised by desktop E2E.
vi.mock("@reelterminal/ui/components/popover", async () => {
  const React = await import("react");
  type Scope = { open: boolean; trigger: { current: HTMLButtonElement | null } };
  const Context = React.createContext<Scope | null>(null);
  const Popover = ({ open, children }: { open: boolean; children: React.ReactNode }) => {
    const trigger = React.useRef<HTMLButtonElement | null>(null);
    return <Context.Provider value={{ open, trigger }}>{children}</Context.Provider>;
  };
  const PopoverTrigger = ({ children }: { children: React.ReactElement }) => {
    const scope = React.useContext(Context)!;
    return React.cloneElement(children as React.ReactElement<{ ref: unknown }>, { ref: scope.trigger });
  };
  type ContentProps = React.HTMLAttributes<HTMLDivElement> & { onCloseAutoFocus?: (event: Event) => void };
  function FocusContent({ scope, onCloseAutoFocus, ...props }: ContentProps & { scope: Scope }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const close = React.useRef(onCloseAutoFocus);
    close.current = onCloseAutoFocus;
    React.useEffect(() => {
      ref.current?.querySelector<HTMLElement>("input,button")?.focus();
      return () => { setTimeout(() => {
        const event = new Event("close-autofocus", { cancelable: true });
        close.current?.(event);
        if (!event.defaultPrevented) scope.trigger.current?.focus();
      }, 0); };
    }, [scope.trigger]);
    return <div {...props} ref={ref} role="dialog" data-state="open" />;
  }
  const PopoverContent = (props: ContentProps) => {
    const scope = React.useContext(Context)!;
    return scope.open ? <FocusContent {...props} scope={scope} /> : null;
  };
  return { Popover, PopoverTrigger, PopoverContent };
});

function InstructionHandoff() {
  const [picker, setPicker] = useState(true);
  const [editor, setEditor] = useState(false);
  return <>
    <ToolcraftPopover label="Instruction picker" isOpen={picker} onOpenChange={setPicker}
      content={<button onClick={() => { setPicker(false); setEditor(true); }}>Edit selected instruction</button>}>
      <button>Add instruction</button>
    </ToolcraftPopover>
    <ToolcraftPopover label="Instruction editor" isOpen={editor} onOpenChange={setEditor}
      content={<input aria-label="Instruction title" />}>
      <button>Edit instruction</button>
    </ToolcraftPopover>
  </>;
}

it("retains the new instruction editor when the previous picker restores focus late", async () => {
  render(<InstructionHandoff />);
  fireEvent.click(screen.getByRole("button", { name: "Edit selected instruction" }));
  // Radix restores focus from the previous scope in a deferred unmount task.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const title = screen.getByRole("textbox", { name: "Instruction title" });
  expect(document.activeElement).toBe(title);
  expect(screen.getByRole("dialog", { name: "Instruction editor" })).toBeInTheDocument();
});

it("returns focus to the instruction trigger when no other dialog owns it", async () => {
  function SingleInstruction() {
    const [open, setOpen] = useState(true);
    return <ToolcraftPopover label="Instruction editor" isOpen={open} onOpenChange={setOpen}
      content={<button onClick={() => setOpen(false)}>Done</button>}>
      <button>Edit instruction</button>
    </ToolcraftPopover>;
  }
  render(<SingleInstruction />);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit instruction" }));
});
