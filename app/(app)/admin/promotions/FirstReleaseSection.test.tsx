import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstReleaseSection } from './FirstReleaseSection';

const candidate = {
  promotionId: 'p1',
  forgeId: 'f1',
  forgeName: 'Second Set of Eyes',
  slug: 'second-set-of-eyes',
  version: 'v1.0.0',
  headSha: 'abc12345',
  decidedAt: '2026-08-21T18:00:00.000Z',
  bundleTags: [] as string[],
};

/** Route fetches by URL substring; throws on anything unexpected. */
function mockFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = Object.entries(handlers).find(([key]) => url.includes(key));
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    return entry[1]();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('FirstReleaseSection', () => {
  it('renders nothing when there are no candidates', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [] }),
    }));
    const { container } = render(<FirstReleaseSection />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists a candidate with its version', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
    }));
    render(<FirstReleaseSection />);
    expect(await screen.findByText('Second Set of Eyes')).toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument();
  });

  it('cuts a bundle and reports where it landed', async () => {
    const cut = vi.fn(() =>
      json({
        bundle: {
          repo: 'second-set-of-eyes-seed', tag: 'v1.0.0', bytes: 4096,
          manifestDigest: 'sha256:abc', migrations: [],
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
      '/bundle': cut,
    }));

    render(<FirstReleaseSection />);
    await userEvent.click(await screen.findByRole('button', { name: /cut bundle/i }));

    await waitFor(() => expect(cut).toHaveBeenCalled());
    expect(await screen.findByText(/second-set-of-eyes-seed:v1\.0\.0/)).toBeInTheDocument();
  });

  it("surfaces the server's refusal", async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate] }),
      '/bundle': () => json({ error: 'database has migrations the release does not' }, 400),
    }));

    render(<FirstReleaseSection />);
    await userEvent.click(await screen.findByRole('button', { name: /cut bundle/i }));

    expect(await screen.findByText(/migrations the release does not/i)).toBeInTheDocument();
  });

  it('warns that a bundle already exists for this version', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () =>
        json({ candidates: [{ ...candidate, bundleTags: ['v1.0.0'] }] }),
    }));
    render(<FirstReleaseSection />);
    expect(await screen.findByText(/already cut/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-cut bundle/i })).toBeInTheDocument();
  });
});
