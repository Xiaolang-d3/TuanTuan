import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

// Keep the existing button styling while Base UI supplies switch interaction.
function SwitchRoot(props: Omit<SwitchPrimitive.Root.Props, "render" | "nativeButton">) {
  return <SwitchPrimitive.Root render={<button type="button" />} nativeButton {...props} />;
}

export const Switch = { Root: SwitchRoot, Thumb: SwitchPrimitive.Thumb };
