export const sanitizeNoteContent = (text) => {
  if (!text) return text;

  return (
    text
      // Script tags aur inline event handlers hatao (XSS prevention)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+on\w+\s*=\s*["'][^"']*["'][^>]*>/gi, "")
      // Kisi bhi HTML tag ko poori tarah hata do (notes plain text hain, HTML ki zaroorat nahi)
      .replace(/<[^>]*>/g, "")
      // JavaScript: protocol wale links (XSS vector)
      .replace(/javascript:/gi, "")
      .trim()
  );
};

// ✅ Content length ka bhi limit lagayein (bahut zyada data ek saath na aa jaye)
export const validateContentLength = (text, maxLength = 10000) => {
  if (text && text.length > maxLength) {
    return text.slice(0, maxLength) + "... [content truncated]";
  }
  return text;
};
