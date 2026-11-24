import { Menu } from "@base-ui/react/menu";

// shadcn/ui (Base UI): portal the popup out of the trigger's scroll container.
export function DropdownMenuContent({
  container,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  collisionBoundary,
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "side" | "sideOffset" | "collisionBoundary"> & Pick<Menu.Portal.Props, "container">) {
  return (
    <Menu.Portal container={container}>
      <Menu.Positioner
        className="ui-dropdown-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={8}
      >
        <Menu.Popup {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export { Menu as DropdownMenu };
