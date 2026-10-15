declare module 'unicode-emoji-json' {
  const data: Record<
    string,
    {
      name: string;
      slug: string;
      group: string;
      emoji_version: string;
      skin_tone_support?: boolean;
    }
  >;
  export default data;
}
