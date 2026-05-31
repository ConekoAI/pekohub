import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { SignInModal } from './SignInModal';
import { render } from '~/test/utils';

describe('SignInModal', () => {
  it('should not render when isOpen is false', () => {
    render(<SignInModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByText('Sign in to PekoHub')).not.toBeInTheDocument();
  });

  it('should render when isOpen is true', () => {
    render(<SignInModal isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('Sign in to PekoHub')).toBeInTheDocument();
    expect(screen.getByText('Continue with GitHub')).toBeInTheDocument();
    expect(screen.getByText('Continue with Google')).toBeInTheDocument();
  });

  it('should call onClose when clicking the X button', () => {
    const onClose = vi.fn();
    render(<SignInModal isOpen={true} onClose={onClose} />);

    const closeButton = screen.getByLabelText('Close');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should have correct GitHub OAuth link', () => {
    render(<SignInModal isOpen={true} onClose={vi.fn()} />);

    const githubLink = screen.getByText('Continue with GitHub').closest('a');
    expect(githubLink).toHaveAttribute('href', '/v1/auth/github/authorize');
  });

  it('should have correct Google OAuth link', () => {
    render(<SignInModal isOpen={true} onClose={vi.fn()} />);

    const googleLink = screen.getByText('Continue with Google').closest('a');
    expect(googleLink).toHaveAttribute('href', '/v1/auth/google/authorize');
  });
});
