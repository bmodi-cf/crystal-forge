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
function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
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
    const candidatesFetch = vi.fn(() => json({ candidates: [] }));
    vi.stubGlobal('fetch', mockFetch({ 'first-release-candidates': candidatesFetch }));
    const { container } = render(<FirstReleaseSection />);
    // The empty render must follow an actual fetch, not just the initial
    // `useState([])` — otherwise this test can't tell "fetched and empty"
    // apart from "never fetched at all".
    await waitFor(() => expect(candidatesFetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing rather than crashing when the response has no candidates field', async () => {
    vi.stubGlobal('fetch', mockFetch({
      // A malformed/unexpected response body — no `candidates` key at all.
      'first-release-candidates': () => json({}),
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

  it('keeps a candidate cutting-in-flight even after another cut is started (no shared busy flag)', async () => {
    const candidateB = {
      ...candidate,
      promotionId: 'p2',
      forgeName: 'Another Forge',
      slug: 'another-forge',
    };

    let resolveA: (() => void) | undefined;
    const responseA = new Promise<Response>((resolve) => {
      resolveA = () => resolve(json({ bundle: { repo: 'a-seed', tag: 'v1.0.0', bytes: 1 } }));
    });
    let resolveB: (() => void) | undefined;
    const responseB = new Promise<Response>((resolve) => {
      resolveB = () => resolve(json({ bundle: { repo: 'b-seed', tag: 'v1.0.0', bytes: 1 } }));
    });

    vi.stubGlobal('fetch', mockFetch({
      'first-release-candidates': () => json({ candidates: [candidate, candidateB] }),
      '/p1/bundle': () => responseA,
      '/p2/bundle': () => responseB,
    }));

    render(<FirstReleaseSection />);
    const cutButtons = await screen.findAllByRole('button', { name: /cut bundle/i });
    expect(cutButtons).toHaveLength(2);
    const [buttonA, buttonB] = cutButtons as [HTMLElement, HTMLElement];

    // Start A's cut; it is now in flight (mocked to hang on `responseA`).
    await userEvent.click(buttonA);
    expect(await screen.findByRole('button', { name: /cutting/i })).toBeDisabled();
    expect(buttonB).toBeEnabled();

    // Start B's cut *before* A resolves. With a single shared `busyId`, this
    // overwrite would flip A's button back to enabled/"Cut bundle" — letting
    // an admin fire a duplicate request against A while its first request is
    // still outstanding. With per-candidate `busy`, A must stay disabled and
    // still read "Cutting…".
    await userEvent.click(buttonB);
    const inFlight = screen.getAllByRole('button', { name: /cutting/i });
    expect(inFlight).toHaveLength(2);
    expect(buttonA).toBeDisabled();
    expect(buttonA).toHaveTextContent(/cutting/i);
    expect(buttonB).toBeDisabled();
    expect(buttonB).toHaveTextContent(/cutting/i);

    resolveA?.();
    await waitFor(() => expect(buttonA).toHaveTextContent(/cut bundle/i));
    // B is still genuinely in flight; A resolving must not clear B's flag.
    expect(buttonB).toBeDisabled();
    expect(buttonB).toHaveTextContent(/cutting/i);

    resolveB?.();
    await waitFor(() => expect(buttonB).toHaveTextContent(/cut bundle/i));
  });
});
