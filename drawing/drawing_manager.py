class DrawingManager:

    def __init__(self):
        self.lines = []
        self.horizontal_lines = []

    def add_line(self, start, end):
        self.lines.append((start, end))

    def add_horizontal_line(self, price):
        self.horizontal_lines.append(price)

    def draw(self, ax):

        for start, end in self.lines:
            ax.plot(
                [start[0], end[0]],
                [start[1], end[1]],
                color="yellow",
                linewidth=2
            )

        for price in self.horizontal_lines:
            ax.axhline(
                y=price,
                color="cyan",
                linewidth=1.5,
                linestyle="--"
            )
    def delete_last(self):

        if self.lines:
            self.lines.pop()

        elif self.horizontal_lines:
            self.horizontal_lines.pop()


    def clear_all(self):

        self.lines.clear()
        self.horizontal_lines.clear()