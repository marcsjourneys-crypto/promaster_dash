import argparse
import sys

from PySide6.QtWidgets import QApplication
from promaster_dash.ui.app import MainWindow


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--fullscreen", action="store_true", help="Run fullscreen (Pi/in-vehicle)")
    p.add_argument("--mock", action="store_true", help="Use mock data generator")
    p.add_argument("--night", action="store_true", help="Start in night mode")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    app = QApplication(sys.argv)
    w = MainWindow(start_night=args.night, mock=args.mock)
    if args.fullscreen:
        w.showFullScreen()
    else:
        w.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())