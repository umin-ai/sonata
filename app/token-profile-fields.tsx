"use client";
import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  IMAGE_TYPES,
  MAX_DESCRIPTION,
  MAX_IMAGE_BYTES,
  normalizeDescription,
  normalizeLinks,
} from "@/lib/token-profile";

// Optional token profile on the launch form, like pump.fun's: an image, a short
// description and Website / X / Telegram links. Fixed once the token launches.
export type ProfileDraft = {
  description: string;
  website: string;
  x: string;
  telegram: string;
  image: Blob | null;
  preview: string;
};
export const emptyProfile: ProfileDraft = {
  description: "",
  website: "",
  x: "",
  telegram: "",
  image: null,
  preview: "",
};
export const hasProfile = (p: ProfileDraft) =>
  !!(p.image || p.description.trim() || p.website.trim() || p.x.trim() || p.telegram.trim());

// Square-crops and re-encodes an image to fit the free upload size.
export async function prepareImage(file: File): Promise<Blob> {
  if (!IMAGE_TYPES.includes(file.type))
    throw Error("Use a PNG, JPG, WebP or GIF image.");
  if (file.size > 15_000_000) throw Error("Image too large. Use one under 15 MB.");
  if (file.type === "image/gif" && file.size <= MAX_IMAGE_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  for (const px of [512, 384, 256]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      px,
      px,
    );
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", quality),
      );
      if (blob && blob.type === "image/webp" && blob.size <= MAX_IMAGE_BYTES)
        return blob;
    }
  }
  throw Error("Could not shrink this image enough. Try a simpler one.");
}

// Uploads the profile and returns its metadata URI for the launch.
export async function publishProfile(
  name: string,
  symbol: string,
  p: ProfileDraft,
): Promise<string> {
  const description = normalizeDescription(p.description);
  const links = normalizeLinks(p);
  const form = new FormData();
  form.set("name", name);
  form.set("symbol", symbol);
  if (description) form.set("description", description);
  for (const [k, v] of Object.entries(links)) form.set(k, v);
  if (p.image) form.set("image", p.image, "logo");
  const r = await fetch("/api/token-profile", { method: "POST", body: form });
  const body = (await r.json()) as { uri?: string; error?: string };
  if (!r.ok || !body.uri) throw Error(body.error ?? "Profile upload failed.");
  return body.uri;
}

export function TokenProfileFields({
  value,
  onChange,
}: {
  value: ProfileDraft;
  onChange: (v: ProfileDraft) => void;
}) {
  const [imageError, setImageError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (v: Partial<ProfileDraft>) => onChange({ ...value, ...v });
  let linkError = "";
  try {
    normalizeLinks(value);
  } catch (e) {
    linkError = (e as Error).message;
  }
  return (
    <div className="token-profile-fields">
      <div>
        <Label htmlFor="token-image">Image (optional)</Label>
        <div className="token-image-picker">
          {value.preview ? (
            <img src={value.preview} alt="Token image preview" width={64} height={64} />
          ) : (
            <span className="token-image-empty" aria-hidden="true">
              <ImagePlus size={22} />
            </span>
          )}
          <div>
            <input
              ref={fileRef}
              id="token-image"
              type="file"
              accept={IMAGE_TYPES.join(",")}
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setImageError("");
                try {
                  const blob = await prepareImage(file);
                  if (value.preview) URL.revokeObjectURL(value.preview);
                  update({ image: blob, preview: URL.createObjectURL(blob) });
                } catch (err) {
                  setImageError((err as Error).message);
                }
              }}
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {value.image ? "Change image" : "Choose image"}
              </Button>
              {value.image && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    URL.revokeObjectURL(value.preview);
                    update({ image: null, preview: "" });
                  }}
                >
                  <X size={14} /> Remove
                </Button>
              )}
            </div>
            <p className="sr-note">Square works best. Resized to 512 × 512.</p>
            {imageError && <p className="sr-note text-destructive" role="alert">{imageError}</p>}
          </div>
        </div>
      </div>
      <details className="launch-disclosure" open={!!(value.description || value.website || value.x || value.telegram)}>
        <summary>Add a description and links (optional)</summary>
        <div className="mt-3">
          <Label htmlFor="token-description">Description (optional)</Label>
          <Textarea
            id="token-description"
            value={value.description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            placeholder="What is this community about?"
            onChange={(e) => update({ description: e.target.value })}
          />
        </div>
        {(["website", "x", "telegram"] as const).map((kind) => (
          <div key={kind} className="mt-3">
            <Label htmlFor={`token-${kind}`}>
              {kind === "x" ? "X" : kind === "telegram" ? "Telegram" : "Website"}
            </Label>
            <Input
              id={`token-${kind}`}
              inputMode="url"
              placeholder={
                kind === "x" ? "https://x.com/…" : kind === "telegram" ? "https://t.me/…" : "https://…"
              }
              value={value[kind]}
              onChange={(e) => update({ [kind]: e.target.value } as Partial<ProfileDraft>)}
            />
          </div>
        ))}
        {linkError && <p className="sr-note text-destructive mt-2" role="alert">{linkError}</p>}
      </details>
      <p className="sr-note">
        Saved permanently with the token.
      </p>
    </div>
  );
}
