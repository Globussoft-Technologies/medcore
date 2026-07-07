/**
 * MarketingNav coverage suite.
 *
 * What: smoke render + structural assertions for the marketing top nav
 * (brand logos with home-link wiring, desktop link list, login + demo CTAs,
 * mobile-menu toggle that mounts/unmounts the off-canvas drawer, and the
 * mobile drawer's onClick-close-on-link wiring).
 * Which: apps/web/src/app/(marketing)/_components/MarketingNav.tsx.
 * Why: the file shipped with no tests (per test-cron pick 2026-05-26). The
 * component is a client component with a single useState toggle; we mock
 * next/link + next/image + the Container wrapper (mirroring the sibling
 * MarketingFooter.test.tsx convention) and assert wiring + toggle behavior
 * via @testing-library/react.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, onClick, ...rest }: any) => (
    <a
      href={typeof href === "string" ? href : "#"}
      onClick={onClick}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ alt, src, ...rest }: any) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      alt={alt}
      src={typeof src === "string" ? src : (src?.src ?? "")}
      {...rest}
    />
  ),
}));
vi.mock("../Container", () => ({
  Container: ({ children, className }: any) => (
    <div data-testid="container" className={className}>
      {children}
    </div>
  ),
}));
vi.mock("lucide-react", () => ({
  Menu: (props: any) => <svg data-testid="icon-menu" {...props} />,
  X: (props: any) => <svg data-testid="icon-x" {...props} />,
}));
// HospitalQrScanner is a self-contained client component (camera + upload,
// uses next/navigation's useRouter). It has its own test surface, so stub it
// here to a button — otherwise its useRouter() throws "app router not mounted"
// in this router-less render and it pulls in lucide icons this file doesn't mock.
vi.mock("@/components/HospitalQrScanner", () => ({
  // Stub as a NON-button element: the nav's own tests assert there's exactly
  // one <button> (the mobile toggle), so the scanner stub must not add another.
  HospitalQrScanner: ({ className }: { className?: string }) => (
    <span data-testid="scan-hospital-qr" className={className}>
      Scan Hospital QR
    </span>
  ),
}));

import { MarketingNav } from "../MarketingNav";

afterEach(() => cleanup());

describe("MarketingNav", () => {
  it("smoke renders the <header> landmark without throwing", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("wraps content in the marketing Container", () => {
    render(<MarketingNav />);
    expect(screen.getByTestId("container")).toBeInTheDocument();
  });

  describe("brand logo", () => {
    it("renders both brand logo variants (light + dark) with MedCore alt", () => {
      render(<MarketingNav />);
      const logos = screen.getAllByAltText("MedCore");
      // Desktop nav renders both light and dark variants (CSS-toggled).
      expect(logos.length).toBe(2);
    });

    it("wraps the logo in a Link pointing at '/'", () => {
      render(<MarketingNav />);
      const logos = screen.getAllByAltText("MedCore");
      // Both logos sit inside the same home link — their nearest <a> ancestor
      // should have href='/'.
      const homeAnchor = logos[0].closest("a");
      expect(homeAnchor).not.toBeNull();
      expect(homeAnchor?.getAttribute("href")).toBe("/");
    });

    it("renders the logos with priority + fixed dimensions", () => {
      render(<MarketingNav />);
      const logos = screen.getAllByAltText("MedCore");
      logos.forEach((img) => {
        expect(img.getAttribute("width")).toBe("160");
        expect(img.getAttribute("height")).toBe("32");
      });
    });
  });

  describe("desktop nav links", () => {
    it("renders all five primary nav links with correct hrefs", () => {
      render(<MarketingNav />);
      const expected: Array<[string, string]> = [
        ["Features", "/features"],
        ["Solutions", "/solutions"],
        ["Pricing", "/pricing"],
        ["About", "/about"],
        ["Contact", "/contact"],
      ];
      for (const [label, href] of expected) {
        // Both desktop + mobile drawer can mount the same labels — when the
        // drawer is CLOSED on initial render, only the desktop copy exists.
        const link = screen.getByRole("link", { name: label });
        expect(link.getAttribute("href")).toBe(href);
      }
    });

    it("renders the desktop <nav> region with all five links inside", () => {
      const { container } = render(<MarketingNav />);
      const navs = container.querySelectorAll("nav");
      // Header has exactly one <nav> for the desktop link row.
      expect(navs.length).toBe(1);
      const navLinks = within(navs[0] as HTMLElement).getAllByRole("link");
      expect(navLinks.length).toBe(5);
    });
  });

  describe("CTAs", () => {
    it("renders the Log in link pointing at /login", () => {
      render(<MarketingNav />);
      const login = screen.getByRole("link", { name: /log in/i });
      expect(login.getAttribute("href")).toBe("/login");
    });

    it("renders the Book a demo CTA pointing at /contact", () => {
      render(<MarketingNav />);
      const cta = screen.getByRole("link", { name: /book a demo/i });
      expect(cta.getAttribute("href")).toBe("/contact");
    });

    it("renders the Book appointment CTA pointing at /book", () => {
      render(<MarketingNav />);
      const cta = screen.getByRole("link", { name: /book appointment/i });
      expect(cta.getAttribute("href")).toBe("/book");
    });
  });

  describe("mobile menu toggle", () => {
    it("renders the toggle button with an accessible label", () => {
      render(<MarketingNav />);
      const toggle = screen.getByRole("button", { name: /toggle menu/i });
      expect(toggle).toBeInTheDocument();
    });

    it("shows the Menu icon by default (drawer closed)", () => {
      render(<MarketingNav />);
      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(screen.queryByTestId("icon-x")).not.toBeInTheDocument();
    });

    it("opens the mobile drawer when the toggle button is clicked", () => {
      render(<MarketingNav />);
      // Closed state — exactly 5 nav-link instances (desktop only).
      expect(screen.getAllByRole("link", { name: "Features" }).length).toBe(1);

      const toggle = screen.getByRole("button", { name: /toggle menu/i });
      fireEvent.click(toggle);

      // Drawer opened — icon flips to X, drawer mounts mobile copies.
      expect(screen.getByTestId("icon-x")).toBeInTheDocument();
      expect(screen.queryByTestId("icon-menu")).not.toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "Features" }).length).toBe(2);
    });

    it("closes the drawer when the toggle is clicked a second time", () => {
      render(<MarketingNav />);
      const toggle = screen.getByRole("button", { name: /toggle menu/i });
      fireEvent.click(toggle); // open
      expect(screen.getByTestId("icon-x")).toBeInTheDocument();
      fireEvent.click(toggle); // close
      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(screen.queryByTestId("icon-x")).not.toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "Features" }).length).toBe(1);
    });
  });

  describe("mobile drawer contents (after open)", () => {
    it("mounts all five primary nav links inside the drawer", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      for (const label of ["Features", "Solutions", "Pricing", "About", "Contact"]) {
        // Both desktop + drawer instances now exist; assert each has 2 copies.
        expect(screen.getAllByRole("link", { name: label }).length).toBe(2);
      }
    });

    it("mounts duplicate Log in + Book a demo CTAs in the drawer", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      expect(screen.getAllByRole("link", { name: /log in/i }).length).toBe(2);
      expect(screen.getAllByRole("link", { name: /book a demo/i }).length).toBe(
        2
      );
    });

    it("mounts a duplicate Book appointment CTA in the drawer", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      expect(
        screen.getAllByRole("link", { name: /book appointment/i }).length
      ).toBe(2);
    });

    it("closes the drawer when the mobile Book appointment CTA is clicked", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      // Click the SECOND Book appointment link (the drawer copy) to invoke its
      // onClick={() => setOpen(false)} close handler.
      const ctas = screen.getAllByRole("link", { name: /book appointment/i });
      fireEvent.click(ctas[1]);

      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(
        screen.getAllByRole("link", { name: /book appointment/i }).length
      ).toBe(1);
    });

    it("closes the drawer when a mobile nav link is clicked", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));
      expect(screen.getByTestId("icon-x")).toBeInTheDocument();

      // Click the SECOND Features link (the one inside the drawer).
      const featuresLinks = screen.getAllByRole("link", { name: "Features" });
      fireEvent.click(featuresLinks[1]);

      // Drawer closes — back to one Features link + Menu icon.
      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "Features" }).length).toBe(1);
    });

    it("closes the drawer when the mobile Log in link is clicked", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      const loginLinks = screen.getAllByRole("link", { name: /log in/i });
      fireEvent.click(loginLinks[1]);

      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /log in/i }).length).toBe(1);
    });

    it("closes the drawer when the mobile Book a demo CTA is clicked", () => {
      render(<MarketingNav />);
      fireEvent.click(screen.getByRole("button", { name: /toggle menu/i }));

      const ctas = screen.getAllByRole("link", { name: /book a demo/i });
      fireEvent.click(ctas[1]);

      expect(screen.getByTestId("icon-menu")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /book a demo/i }).length).toBe(
        1
      );
    });
  });

  describe("a11y", () => {
    it("the toggle button exposes aria-label='Toggle menu'", () => {
      render(<MarketingNav />);
      const toggle = screen.getByRole("button");
      expect(toggle.getAttribute("aria-label")).toBe("Toggle menu");
    });

    it("the header is the only banner landmark on the page", () => {
      render(<MarketingNav />);
      // Only one <header> should render — and it should be the top-level
      // sticky element. No other banner landmarks expected.
      const banners = screen.getAllByRole("banner");
      expect(banners.length).toBe(1);
    });
  });
});
