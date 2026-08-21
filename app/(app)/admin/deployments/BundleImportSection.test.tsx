import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BundleImportSection } from './BundleImportSection';

const candidate = {
  slug: 'second-set-of-eyes',
  repo: 'second-set-of-eyes-seed',
  versions: ['v1.0.0'],
};

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

describe('BundleImportSection', () => {
  it('renders nothing when the registry offers no bundles', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/deployments/bundles': () => json({ candidates: [] }),
    }));
    const { container } = render(<BundleImportSection onImported={() => {}} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists an available bundle', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));
    render(<BundleImportSection onImported={() => {}} />);
    expect(await screen.findByText('second-set-of-eyes')).toBeInTheDocument();
  });

  it('asks for confirmation before importing, then imports', async () => {
    const doImport = vi.fn(() =>
      json({
        imported: {
          forgeId: 'f1', slug: 'second-set-of-eyes', version: 'v1.0.0',
          bundleDigest: 'sha256:abc', deployEnabled: true,
        },
      }),
    );
    const onImported = vi.fn();
    // '/import' must be matched before the bare listing path.
    vi.stubGlobal('fetch', mockFetch({
      '/import': doImport,
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));

    render(<BundleImportSection onImported={onImported} />);
    await userEvent.click(await screen.findByRole('button', { name: /^import$/i }));

    // Nothing has been sent yet — the dialog is the gate.
    expect(doImport).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /import data/i }));

    await waitFor(() => expect(doImport).toHaveBeenCalled());
    expect(onImported).toHaveBeenCalled();
    expect(await screen.findByText(/imported/i)).toBeInTheDocument();
  });

  it('surfaces a refusal from the server', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/import': () => json({ error: 'Database second_set_of_eyes was already seeded' }, 400),
      '/api/deployments/bundles': () => json({ candidates: [candidate] }),
    }));

    render(<BundleImportSection onImported={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /^import$/i }));
    await userEvent.click(screen.getByRole('button', { name: /import data/i }));

    expect(await screen.findByText(/already seeded/i)).toBeInTheDocument();
  });
});
