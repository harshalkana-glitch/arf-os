/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than a build artefact,
  // so Next must transpile them (CLAUDE.md 18.5: one source of truth for
  // contract types, never a duplicated copy in the web app).
  transpilePackages: ['@arf/contracts'],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
