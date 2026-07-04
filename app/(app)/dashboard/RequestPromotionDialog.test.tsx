import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestPromotionDialog } from './RequestPromotionDialog';

function renderDialog(currentVersion: string | null) {
  return render(
    <RequestPromotionDialog
      open
      onOpenChange={() => {}}
      forgeName="Aquaflow"
      currentVersion={currentVersion}
      onConfirm={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe('RequestPromotionDialog', () => {
  it('shows capitalized bump buttons with Minor selected by default', () => {
    renderDialog('v1.2.3');
    expect(screen.getByRole('button', { name: 'Major' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Minor' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Patch' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the current version and the resultant version for the selected bump', async () => {
    renderDialog('v1.2.3');
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    // Minor default: v1.2.3 -> v1.3.0
    expect(screen.getByText('v1.3.0')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Major' }));
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Patch' }));
    expect(screen.getByText('v1.2.4')).toBeInTheDocument();
  });

  it('handles a forge with no releases yet (first release is always v1.0.0)', () => {
    renderDialog(null);
    expect(screen.getByText(/no releases yet/i)).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  it('labels the confirm button "Start Production Release"', () => {
    renderDialog('v1.2.3');
    expect(screen.getByRole('button', { name: 'Start Production Release' })).toBeInTheDocument();
  });
});
