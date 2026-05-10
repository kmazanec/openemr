import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EditModal } from './EditModal';

describe('EditModal', () => {
  it('renders the title and content when open', () => {
    render(
      <EditModal
        open
        title="Edit thing"
        onSubmit={() => undefined}
        onClose={() => undefined}
      >
        <p>Body content</p>
      </EditModal>,
    );
    expect(screen.getByTestId('dashboard-edit-modal-title')).toHaveTextContent('Edit thing');
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('returns null when closed', () => {
    const { container } = render(
      <EditModal
        open={false}
        title="Edit thing"
        onSubmit={() => undefined}
        onClose={() => undefined}
      >
        <p>Body content</p>
      </EditModal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('fires onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <EditModal open title="Edit thing" onSubmit={() => undefined} onClose={onClose}>
        <p />
      </EditModal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('fires onClose when the scrim is clicked', () => {
    const onClose = vi.fn();
    render(
      <EditModal open title="Edit thing" onSubmit={() => undefined} onClose={onClose}>
        <p />
      </EditModal>,
    );
    fireEvent.click(screen.getByTestId('dashboard-edit-modal-scrim'));
    expect(onClose).toHaveBeenCalled();
  });

  it('fires onSubmit when the save button is clicked', () => {
    const onSubmit = vi.fn();
    render(
      <EditModal open title="Edit thing" onSubmit={onSubmit} onClose={() => undefined}>
        <p />
      </EditModal>,
    );
    fireEvent.click(screen.getByTestId('dashboard-edit-modal-save'));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('shows the saving state and disables the save button while saving', () => {
    render(
      <EditModal
        open
        title="Edit thing"
        saving
        onSubmit={() => undefined}
        onClose={() => undefined}
      >
        <p />
      </EditModal>,
    );
    const save = screen.getByTestId('dashboard-edit-modal-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent(/saving/i);
  });

  it('renders an error banner when error is set', () => {
    render(
      <EditModal
        open
        title="Edit thing"
        error="Something went wrong"
        onSubmit={() => undefined}
        onClose={() => undefined}
      >
        <p />
      </EditModal>,
    );
    expect(screen.getByTestId('dashboard-edit-modal-error')).toHaveTextContent(
      'Something went wrong',
    );
  });
});
