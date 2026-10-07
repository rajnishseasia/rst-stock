import { describe, expect, test } from "bun:test";
import { AlertDialogContent, AlertDialogOverlay } from "./alert-dialog";

/**
 * AlertDialog must stack above every other fixed layer in the app: the
 * mobile trade sheet (`fixed inset-0 z-[70]`, see caller-sheet.tsx) and the
 * sticky app headers / other modals (`z-50`). It also has to stay usable on
 * short mobile viewports, where the dialog can be taller than the visible
 * viewport.
 *
 * These assertions call the real exported components directly (the same
 * functions React invokes when rendering `<AlertDialogOverlay />` and
 * `<AlertDialogContent />`) and read the actual `className` each one
 * computes via `cn()`. Full DOM rendering isn't available here: this
 * component's overlay/content are only ever mounted through a Radix Portal,
 * and `react-dom/server` refuses to render portals at all ("Portals are not
 * currently supported by the server renderer"), so `renderToStaticMarkup`
 * would just observe an empty tree. Calling the components as plain
 * functions is the one way to exercise their real, computed output here:
 * unlike scanning the source text, this fails if `cn()`'s merge behavior
 * changes, if the class literal itself changes, or if `AlertDialogContent`
 * stops rendering the overlay at all -- and it does not fail for
 * reformatting, reordering, or renames elsewhere in the file.
 */
describe("AlertDialog layering", () => {
  test("overlay covers the viewport above other fixed chrome", () => {
    const overlayElement = AlertDialogOverlay({});
    const overlayClassName = overlayElement.props.className as string;

    expect(overlayClassName).toContain("fixed inset-0 z-[80]");
    expect(overlayClassName).not.toContain("z-50");
  });

  test("content is centered above the overlay and scrolls its own overflow on short viewports", () => {
    const portalElement = AlertDialogContent({});
    const children = portalElement.props.children as [
      { type: typeof AlertDialogOverlay },
      { props: { className: string } },
    ];
    const [overlayChild, contentPrimitiveElement] = children;

    // AlertDialogContent must still mount the overlay alongside its content,
    // not just carry a matching className somewhere unused.
    expect(overlayChild.type).toBe(AlertDialogOverlay);

    const contentClassName = contentPrimitiveElement.props.className;
    expect(contentClassName).toContain("fixed top-1/2 left-1/2 z-[90]");
    expect(contentClassName).toContain("max-h-[calc(100dvh-2rem)]");
    expect(contentClassName).toContain("overflow-y-auto");
    expect(contentClassName).toContain("overscroll-contain");
    expect(contentClassName).not.toContain("z-50");
  });
});
