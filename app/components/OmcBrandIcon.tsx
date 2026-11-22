"use client";

import { useState } from "react";
import Image from "next/image";
import { Box, Server } from "lucide-react";
import { LOBE_ICON_CATALOG, lobeIconSlug } from "@/lib/branding/omc/lobeIconCatalog";

const CATALOG_BY_ID = new Map(LOBE_ICON_CATALOG.map((entry) => [entry.id, entry]));
// OMC keeps Kimi's white glyph in its monochrome artwork so it can follow the active theme.
const WHITE_GLYPH_COLOR_ICONS = new Set(["Kimi"]);

type OmcBrandIconProps = {
  iconId?: string;
  size?: number;
  className?: string;
  testId?: string;
  fallback?: "server" | "box";
};

export function OmcBrandIcon({
  iconId,
  size = 20,
  className,
  testId,
  fallback = "server",
}: OmcBrandIconProps) {
  const entry = iconId ? CATALOG_BY_ID.get(iconId) : undefined;
  if (!entry || !iconId) {
    return (
      <span
        aria-hidden="true"
        className={["inline-flex shrink-0 items-center justify-center", className].filter(Boolean).join(" ")}
        style={{ width: size, height: size }}
        data-testid={testId}
        data-icon-id={iconId ?? ""}
      >
        {fallback === "box"
          ? <Box size={Math.round(size * 0.82)} strokeWidth={1.5} />
          : <Server size={Math.round(size * 0.82)} strokeWidth={1.5} />}
      </span>
    );
  }

  return <OmcCatalogIcon key={iconId} iconId={iconId} size={size} className={className} testId={testId} hasColor={entry.hasColor} />;
}

function OmcCatalogIcon({
  iconId,
  size,
  className,
  testId,
  hasColor,
}: {
  iconId: string;
  size: number;
  className?: string;
  testId?: string;
  hasColor: boolean;
}) {
  const [colorFailed, setColorFailed] = useState(false);
  const slug = lobeIconSlug(iconId);
  const isColor = hasColor && !WHITE_GLYPH_COLOR_ICONS.has(iconId);
  const monoSource = `/lobe-icons/${slug}.svg`;

  return (
    <span
      aria-hidden="true"
      className={["inline-flex shrink-0 items-center justify-center", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      data-testid={testId}
      data-icon-id={iconId}
    >
      {isColor && !colorFailed ? (
        <Image
          src={`/lobe-icons/${slug}-color.svg`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          unoptimized
          className="block h-full w-full object-contain"
          onError={() => setColorFailed(true)}
        />
      ) : (
        <span
          className="block h-full w-full"
          style={{
            backgroundColor: "currentColor",
            mask: `url("${monoSource}") center / contain no-repeat`,
            WebkitMask: `url("${monoSource}") center / contain no-repeat`,
          }}
        />
      )}
    </span>
  );
}
