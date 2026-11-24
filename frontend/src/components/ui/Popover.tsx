import { Popover } from "@base-ui/react/popover";
import "./popover.css";

type PopoverContentProps = Popover.Popup.Props
  & Pick<Popover.Positioner.Props, "align" | "side" | "sideOffset" | "collisionBoundary">
  & Pick<Popover.Portal.Props, "container">;

export function PopoverContent({
  container,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  collisionBoundary,
  ...props
}: PopoverContentProps) {
  return (
    <Popover.Portal container={container}>
      <Popover.Positioner
        className="ui-popover-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={8}
      >
        <Popover.Popup {...props} />
      </Popover.Positioner>
    </Popover.Portal>
  );
}

export { Popover };
