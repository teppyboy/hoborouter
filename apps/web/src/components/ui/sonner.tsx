import { Toaster as Sonner } from "sonner";

function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "bg-popover text-popover-foreground border border-border rounded-lg shadow-md text-sm",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}

export { Toaster };
