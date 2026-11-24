import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";

type ComboboxContentProps = ComboboxPrimitive.Popup.Props & Pick<
  ComboboxPrimitive.Positioner.Props,
  "align" | "side" | "sideOffset" | "alignOffset" | "anchor"
>;

// Adapted from the shadcn/ui Base UI registry. Feature CSS supplies the styles.
const Combobox = ComboboxPrimitive.Root;
const ComboboxValue = ComboboxPrimitive.Value;

function ComboboxTrigger({ children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger data-slot="combobox-trigger" {...props}>
      {children}
      <ComboboxPrimitive.Icon render={<ChevronDown size={14} aria-hidden="true" />} />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxInput(props: ComboboxPrimitive.Input.Props) {
  return <ComboboxPrimitive.Input data-slot="combobox-input" {...props} />;
}

function ComboboxContent({ align = "start", side = "bottom", sideOffset = 6, alignOffset, anchor, ...props }: ComboboxContentProps) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} alignOffset={alignOffset} anchor={anchor} data-slot="combobox-positioner">
        <ComboboxPrimitive.Popup data-slot="combobox-content" {...props} />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList(props: ComboboxPrimitive.List.Props) {
  return <ComboboxPrimitive.List data-slot="combobox-list" {...props} />;
}

function ComboboxItem({ children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item data-slot="combobox-item" {...props}>
      {children}
      <ComboboxPrimitive.ItemIndicator data-slot="combobox-item-indicator" aria-hidden="true">
        <Check size={14} />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty(props: ComboboxPrimitive.Empty.Props) {
  return <ComboboxPrimitive.Empty data-slot="combobox-empty" {...props} />;
}

export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue };
