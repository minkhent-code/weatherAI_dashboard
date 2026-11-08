"""Compatibility entry point for the Myanmar historical event loader."""

if __package__:
    from .historical_events import main
else:
    from historical_events import main


if __name__ == "__main__":
    main()
